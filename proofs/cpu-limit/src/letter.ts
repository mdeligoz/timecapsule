const BLOCK = `## A note for later

Dear me, it is **a quiet morning** and I am writing this with *cold coffee* beside me. Some plans ~~never happened~~ and that is fine.

- Call the people you miss
- Walk somewhere *new* every month
- Keep the **small** promises

1. Finish the book
2. Learn the song
3. Plant the tree

> Whatever you are worried about today, it probably worked out.

Here is the [song we liked](https://example.com/song?id=42) and a \`little note\` in code.

<p onclick="alert(1)">Pasted text from somewhere else.</p><script>alert(2)</script>

---

`;

export function sampleLetter(length = 50_000): string {
  return BLOCK.repeat(Math.ceil(length / BLOCK.length)).slice(0, length);
}
