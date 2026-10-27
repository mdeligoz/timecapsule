export type EmailInput = {
  from: string;
  to: string;
  subject: string;
  html: string;
  files: { filename: string; url: string }[];
};

// Resend's send-email body. Each file is fetched by Resend from its signed link; the links
// go only in `attachments`, never in what the reader sees.
export function buildEmail(input: EmailInput) {
  return {
    from: input.from,
    to: [input.to],
    subject: input.subject,
    html: input.html,
    attachments: input.files.map((f) => ({ filename: f.filename, path: f.url })),
  };
}
