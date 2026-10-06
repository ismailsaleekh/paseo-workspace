// Marks count complete LF-delimited records, not split()'s trailing empty entry. A partial last
// record is deferred until its newline arrives, so an append cannot disappear behind a mark.
export function completeLogLines(text) {
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) return [];
  return text
    .slice(0, lastNewline)
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}
