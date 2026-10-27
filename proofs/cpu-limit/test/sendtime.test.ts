import { describe, expect, it } from "vitest";
import { sendInstant } from "../src/sendtime";

describe("sendInstant", () => {
  it("resolves a local time in a zone ahead of UTC", () => {
    expect(new Date(sendInstant("2027-01-15T09:00", "Europe/Istanbul")).toISOString()).toBe("2027-01-15T06:00:00.000Z");
  });

  it("follows summer time", () => {
    expect(new Date(sendInstant("2027-07-01T09:00", "America/New_York")).toISOString()).toBe("2027-07-01T13:00:00.000Z");
    expect(new Date(sendInstant("2027-01-01T09:00", "America/New_York")).toISOString()).toBe("2027-01-01T14:00:00.000Z");
  });

  it("sends a skipped local time at the next valid time", () => {
    // New York skips 02:00–03:00 on 2027-03-14.
    expect(new Date(sendInstant("2027-03-14T02:30", "America/New_York")).toISOString()).toBe("2027-03-14T07:00:00.000Z");
  });

  it("sends a repeated local time at its first occurrence", () => {
    // New York repeats 01:00–02:00 on 2027-11-07; the first 01:30 is still summer time (UTC−4).
    expect(new Date(sendInstant("2027-11-07T01:30", "America/New_York")).toISOString()).toBe("2027-11-07T05:30:00.000Z");
  });
});
