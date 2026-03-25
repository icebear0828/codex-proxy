function fallbackCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;top:0;left:0;width:2em;height:2em;padding:0;border:none;outline:none;box-shadow:none;background:transparent;opacity:0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  document.body.removeChild(ta);
  return ok;
}

/**
 * Last-resort: show a prompt dialog with the text pre-selected so the user
 * can Ctrl+C / Cmd+C manually. Works on any origin regardless of security.
 */
function promptCopy(text: string): void {
  window.prompt("Ctrl+C / Cmd+C", text);
}

export async function clipboardCopy(text: string): Promise<boolean> {
  // Clipboard API only works in secure contexts (HTTPS or localhost)
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
  }
  // execCommand fallback
  if (fallbackCopy(text)) return true;
  // Last resort: prompt dialog
  promptCopy(text);
  return true;
}
