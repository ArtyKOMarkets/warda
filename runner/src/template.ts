/**
 * `{{name}}` substitution in notification text. Names only, from a fixed
 * context; an unknown name is left visible rather than silently blanked, so a
 * typo in a message shows up in the message.
 */
export function fill(text: string, ctx: Record<string, string | number | null | undefined>): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, name: string) => {
    const v = ctx[name];
    return v === undefined || v === null ? whole : String(v);
  });
}
