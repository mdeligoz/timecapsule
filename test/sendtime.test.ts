import { describe, expect, it } from "vitest";
import { DAY, firstSendHour } from "../src/dates";
import { sendMoment } from "../src/sendtime";

const utc = (iso: string) => Date.parse(iso);

describe("send time", () => {
  it("sends 10:00 in Chicago at 16:00 UTC before the March clock change", () => {
    expect(sendMoment("2030-03-01T10:00", "America/Chicago")).toBe(utc("2030-03-01T16:00Z"));
  });

  it("sends 10:00 in Chicago at 15:00 UTC after the March clock change", () => {
    expect(sendMoment("2030-03-15T10:00", "America/Chicago")).toBe(utc("2030-03-15T15:00Z"));
  });

  it("sends 10:00 in Istanbul at 07:00 UTC in winter and in summer", () => {
    expect(sendMoment("2030-01-15T10:00", "Europe/Istanbul")).toBe(utc("2030-01-15T07:00Z"));
    expect(sendMoment("2030-07-15T10:00", "Europe/Istanbul")).toBe(utc("2030-07-15T07:00Z"));
  });

  it("follows Sydney's summer time, which runs from October to April", () => {
    expect(sendMoment("2030-01-15T10:00", "Australia/Sydney")).toBe(utc("2030-01-14T23:00Z"));
    expect(sendMoment("2030-07-15T10:00", "Australia/Sydney")).toBe(utc("2030-07-15T00:00Z"));
  });

  it("sends a skipped hour at the first moment after the clock change", () => {
    // Chicago jumps from 2:00 to 3:00 on 10 March 2030.
    expect(sendMoment("2030-03-10T02:00", "America/Chicago")).toBe(utc("2030-03-10T08:00Z"));
  });

  it("sends a skipped hour at the clock change when the clock moves by half an hour", () => {
    // Lord Howe Island jumps from 2:00 to 2:30 on 6 October 2030.
    expect(sendMoment("2030-10-06T02:00", "Australia/Lord_Howe")).toBe(utc("2030-10-05T15:30Z"));
  });

  it("sends a repeated hour at its first occurrence", () => {
    // Chicago goes from 2:00 back to 1:00 on 3 November 2030, so 1:00 happens twice.
    expect(sendMoment("2030-11-03T01:00", "America/Chicago")).toBe(utc("2030-11-03T06:00Z"));
  });

  it("works out a send time 20 years ahead", () => {
    expect(sendMoment("2046-07-15T10:00", "America/Chicago")).toBe(utc("2046-07-15T15:00Z"));
  });

  it("refuses a time that is not on the hour", () => {
    expect(() => sendMoment("2030-03-01T10:30", "America/Chicago")).toThrow();
  });

  it("refuses a date or hour that does not exist", () => {
    expect(() => sendMoment("2030-02-30T10:00", "America/Chicago")).toThrow();
    expect(() => sendMoment("2030-13-01T10:00", "America/Chicago")).toThrow();
    expect(() => sendMoment("2030-03-01T24:00", "America/Chicago")).toThrow();
  });

  it("refuses an unknown time zone", () => {
    expect(() => sendMoment("2030-03-01T10:00", "Mars/Olympus")).toThrow();
  });

  // 1:00 happens twice the night New York's clocks go back, and a send time names its first pass.
  it("offers 2:00 as the earliest hour when 7 days on falls in the first pass of a repeated 1:00", () => {
    const written = utc("2026-10-25T05:15Z");
    expect(firstSendHour(written, "America/New_York")).toBe("2026-11-01T02:00");
  });

  it("offers as the earliest hour one that is at least 7 days on, every quarter hour around clock changes", () => {
    for (const [zone, from] of [
      ["America/New_York", "2026-10-24T00:00Z"],
      ["America/New_York", "2027-03-06T00:00Z"],
      ["Australia/Lord_Howe", "2026-09-26T00:00Z"],
      ["Australia/Lord_Howe", "2027-03-27T00:00Z"],
    ]) {
      for (let written = utc(from); written < utc(from) + 2 * DAY; written += 15 * 60_000) {
        expect(
          sendMoment(firstSendHour(written, zone), zone),
          `${zone} ${new Date(written).toISOString()}`,
        ).toBeGreaterThanOrEqual(written + 7 * DAY);
      }
    }
  });
});
