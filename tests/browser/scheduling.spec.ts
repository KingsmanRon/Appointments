import { expect, test, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  CapabilityGate,
  MockConnector,
} from "../../apps/worker/src/connector.js";
import { Dispatcher } from "../../apps/worker/src/dispatcher.js";

/**
 * Browser acceptance: reception books telephone calls, walk-ins and
 * referrals into Dr M's own diary, and Dr M sees them on his calendar.
 * Synthetic data only; each scenario uses its own future weekday.
 */
const API = "http://localhost:3101";
const TENANT = "11111111-1111-4111-8111-111111111111";
const DR_M = "d0c7a000-0000-4000-8000-000000000001";
const ZONE = "Africa/Johannesburg";

/** The n-th coming date with ISO weekday `wd` (Dr M works Monday to Friday). */
function coming(wd: number, weeksAhead = 1): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(
    new Date(),
  );
  const d = new Date(`${today}T12:00:00Z`);
  do d.setUTCDate(d.getUTCDate() + 1);
  while ((d.getUTCDay() || 7) !== wd);
  d.setUTCDate(d.getUTCDate() + 7 * (weeksAhead - 1));
  return d.toISOString().slice(0, 10);
}
/** Johannesburg wall time (UTC+2) as an instant. */
const at = (day: string, hhmm: string) =>
  new Date(`${day}T${hhmm}:00+02:00`).toISOString();

const headers = (role = "REFERRAL_COORDINATOR", user = "browser-test") => ({
  "x-tenant-id": TENANT,
  "x-access-role": role,
  "x-access-user": user,
  "content-type": "application/json",
});
async function call(method: string, path: string, body?: object) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: headers(),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json() };
}

async function signIn(
  browser: Browser,
  role: string,
  user: string,
): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.getByLabel("Role").selectOption(role);
  await page.getByLabel("Staff name (synthetic)").fill(user);
  await page.getByRole("button", { name: "Enter console" }).click();
  await expect(page.locator(".app")).toBeVisible();
  return page;
}
async function openReception(page: Page, day: string) {
  await page.goto("/#/book");
  await page.getByLabel("Day", { exact: true }).fill(day);
  await expect(page.locator(".slot").first()).toBeVisible();
}
async function fillPatient(
  page: Page,
  given: string,
  family: string,
  phone?: string,
) {
  await page.getByLabel("First name").fill(given);
  await page.getByLabel("Surname").fill(family);
  if (phone) await page.getByLabel(/^Phone/).fill(phone);
}
async function calendarWeekOf(page: Page, day: string) {
  await page.goto("/#/calendar");
  await expect(page.locator(".cal-grid")).toBeVisible();
  for (
    let i = 0;
    i < 4 && !(await page.locator(`.cal-col[data-day="${day}"]`).count());
    i++
  )
    await page.getByRole("button", { name: "Next week" }).click();
  await expect(page.locator(`.cal-col[data-day="${day}"]`)).toBeVisible();
}

test("reception books a telephone call and a walk-in without a referral; Dr M sees both on his own calendar", async ({
  browser,
}) => {
  const day = coming(1);
  const reception = await signIn(
    browser,
    "REFERRAL_COORDINATOR",
    "reception-1",
  );
  await openReception(reception, day);

  await reception.getByRole("button", { name: "09:00", exact: true }).click();
  await fillPatient(reception, "Thandi", "Browsertest", "+27 82 000 0101");
  await reception.getByRole("button", { name: "Book 09:00" }).click();
  await expect(reception.getByRole("status")).toContainText(
    "Booked Thandi Browsertest",
  );

  await reception.getByText("Walk-in", { exact: true }).click();
  await reception.getByLabel("Length").selectOption("30");
  await reception.getByRole("button", { name: "09:30", exact: true }).click();
  await fillPatient(reception, "Sipho", "Browsertest");
  await reception.getByRole("button", { name: "Book 09:30" }).click();
  await expect(reception.getByRole("status")).toContainText(
    "Booked Sipho Browsertest",
  );

  const list = reception.locator(".day-list__item");
  await expect(list).toHaveCount(2);
  await expect(list.first()).toContainText("Telephone");
  await expect(list.nth(1)).toContainText("Walk-in · 30 min");

  const doctor = await signIn(browser, "PRACTITIONER", "dr-m");
  await expect(doctor).toHaveURL(/#\/calendar$/);
  await calendarWeekOf(doctor, day);
  const column = doctor.locator(`.cal-col[data-day="${day}"]`);
  await expect(column.locator(".cal-appt")).toHaveCount(2);
  await expect(column).toContainText("Thandi Browsertest");
  await column.locator(".cal-appt", { hasText: "Sipho" }).click();
  await expect(doctor.locator(".cal-detail")).toContainText("Walk-in");
  // The doctor is not shown the phone number reception holds.
  await column.locator(".cal-appt", { hasText: "Thandi" }).click();
  await expect(doctor.locator(".cal-detail")).not.toContainText("+27 82");
});

test("two receptionists choose the same time: one booking, the other is told and the time disappears", async ({
  browser,
}) => {
  const day = coming(2);
  const a = await signIn(browser, "REFERRAL_COORDINATOR", "reception-a");
  const b = await signIn(browser, "REFERRAL_COORDINATOR", "reception-b");
  for (const page of [a, b]) {
    await openReception(page, day);
    await page.getByRole("button", { name: "10:00", exact: true }).click();
  }
  await fillPatient(a, "First", "Caller", "+27 82 000 0201");
  await fillPatient(b, "Second", "Caller", "+27 82 000 0202");
  await a.getByRole("button", { name: "Book 10:00" }).click();
  await expect(a.getByRole("status")).toContainText("Booked First Caller");
  await b.getByRole("button", { name: "Book 10:00" }).click();
  await expect(b.getByRole("alert")).toContainText("no longer free");
  await expect(
    b.getByRole("button", { name: "10:00", exact: true }),
  ).toHaveCount(0);
  const cal = await call(
    "GET",
    `/v1/schedule/calendar?practitioner_id=${DR_M}&from=${day}&to=${day}`,
  );
  expect(cal.json.appointments).toHaveLength(1);
});

test("reception checks a patient in, moves one and cancels another; the calendar follows", async ({
  browser,
}) => {
  const day = coming(3);
  for (const [time, name] of [
    ["08:00", "Early"],
    ["08:15", "Mover"],
    ["08:30", "Canceller"],
  ] as const)
    expect(
      (
        await call("POST", "/v1/schedule/appointments", {
          channel: "TELEPHONE",
          command_id: randomUUID(),
          practitioner_id: DR_M,
          starts_at: at(day, time),
          patient: {
            given_name: name,
            family_name: "Browsertest",
            phone: "+27 82 000 0300",
          },
        })
      ).status,
    ).toBe(201);
  const page = await signIn(browser, "REFERRAL_COORDINATOR", "reception-1");
  await openReception(page, day);
  const row = (name: string) =>
    page.locator(".day-list__item", { hasText: name });
  await row("Early").getByRole("button", { name: "Check in" }).click();
  await expect(row("Early")).toContainText("Checked in");
  await row("Mover").getByRole("button", { name: "Move" }).click();
  await page.getByRole("button", { name: "11:00", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Moved Mover Browsertest to 11:00",
  );
  await row("Canceller").getByRole("button", { name: "Cancel" }).click();
  await row("Canceller")
    .getByRole("button", { name: "Cancel appointment" })
    .click();
  await expect(row("Canceller")).toContainText("Cancelled");

  const doctor = await signIn(browser, "PRACTITIONER", "dr-m");
  await calendarWeekOf(doctor, day);
  const column = doctor.locator(`.cal-col[data-day="${day}"]`);
  await expect(column.locator(".cal-appt.status-checked_in")).toContainText(
    "Early",
  );
  await expect(column.locator(".cal-appt.status-cancelled")).toContainText(
    "Canceller",
  );
  await expect(column.locator(".cal-appt", { hasText: "Mover" })).toContainText(
    "11:00",
  );
  // Dr M sees the checked-in patient and marks them seen.
  await column.locator(".cal-appt", { hasText: "Early" }).click();
  await expect(doctor.getByRole("button", { name: "Mark seen" })).toBeVisible();
});

test("a ready referral is booked with the patient's details taken from the referral", async ({
  browser,
}) => {
  const day = coming(4);
  const ingested = await call("POST", "/v1/referrals", {
    command_id: randomUUID(),
    referral_id: randomUUID(),
    correlation_id: randomUUID(),
    expected_version: 0,
    filename: "synthetic.txt",
    media_type: "text/plain",
    content_base64: Buffer.from(`synthetic referral ${randomUUID()}`).toString(
      "base64",
    ),
    fixture: "complete",
  });
  expect(ingested.status).toBe(201);
  // The worker delivers it (synthetic destination), making it ready to book.
  const db = new URL(
    process.env.BROWSER_DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5432/access_browser_test",
  );
  db.username = "access_worker";
  db.password = "integration-worker";
  const pool = new pg.Pool({ connectionString: db.toString() });
  try {
    const connector = new MockConnector();
    const worker = new Dispatcher(
      pool,
      connector,
      new CapabilityGate(connector, [
        "referral.create",
        "referral.status.read",
      ]),
      {
        maxDispatch: 3,
        retrySeconds: 0,
        maxReconcile: 3,
        reconcileBaseSeconds: 0,
        tenantIds: [TENANT],
      },
    );
    for (let i = 0; i < 10 && (await worker.tick()); i++);
  } finally {
    await pool.end();
  }
  const page = await signIn(browser, "REFERRAL_COORDINATOR", "reception-1");
  await openReception(page, day);
  await page.getByText("Referral", { exact: true }).click();
  const choice = page.getByLabel("Referral ready for booking");
  await choice.selectOption({ value: ingested.json.case_id });
  await page.getByRole("button", { name: "14:00", exact: true }).click();
  await page.getByRole("button", { name: "Book 14:00" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Booked Synthetic Patient",
  );
  await expect(
    page.locator(".day-list__item", { hasText: "Synthetic Patient" }),
  ).toContainText("Referral");
  // Booked: it leaves the list of referrals waiting for a time.
  await expect(
    choice.locator(`option[value="${ingested.json.case_id}"]`),
  ).toHaveCount(0);
  const detail = await call("GET", `/v1/cases/${ingested.json.case_id}`);
  expect(detail.json.case.current_state).toBe("BOOKED");
});

test("a doctor reaches only his calendar; read-only staff see the diary without names", async ({
  browser,
}) => {
  const day = coming(1, 2);
  expect(
    (
      await call("POST", "/v1/schedule/appointments", {
        channel: "WALK_IN",
        command_id: randomUUID(),
        practitioner_id: DR_M,
        starts_at: at(day, "15:00"),
        patient: { given_name: "Private", family_name: "Browsertest" },
      })
    ).status,
  ).toBe(201);
  const doctor = await signIn(browser, "PRACTITIONER", "dr-m");
  await expect(doctor.locator(".rail__nav a .rail__text")).toHaveText([
    "Calendar",
  ]);
  await doctor.goto("/#/book");
  await expect(doctor).toHaveURL(/#\/calendar$/);
  await doctor.goto("/#/queue");
  await expect(doctor).toHaveURL(/#\/calendar$/);

  const readOnly = await signIn(browser, "READ_ONLY", "auditor");
  await calendarWeekOf(readOnly, day);
  const column = readOnly.locator(`.cal-col[data-day="${day}"]`);
  await expect(column.locator(".cal-appt")).toHaveCount(1);
  await expect(column).toContainText("Patient details hidden");
  await expect(column).not.toContainText("Private");
  await expect(
    readOnly.locator(".rail__nav a", { hasText: "Reception" }),
  ).toHaveCount(0);
});
