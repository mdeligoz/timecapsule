import { describe, expect, it } from "vitest";
import { presign } from "../src/presign.ts";

// AWS's published example for a presigned GET ("Authenticating Requests: Using Query Parameters"
// in the Amazon S3 API reference). The expected signature comes from AWS, not from this code.
describe("presign", () => {
  it("reproduces the signature in AWS's own presigned-URL example", async () => {
    const url = await presign({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      expiresSeconds: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt" +
        "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });
});
