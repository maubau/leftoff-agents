// Rules of the limit meters in the header, plain so they are tested in node like the rest.

/**
 * A Claude account with no window that has a share: its percentage comes only from Claude Code's status line, which
 * terminal sessions have and Paseo's agents do not (D-060). The panel says so under its row.
 */
export function claudeWithoutPercent(w, all = []) {
  if (!w || !/^claude(:|$)/.test(w.id ?? "") || w.usedPercent !== null || w.label || w.valueText !== undefined) return false;
  const account = w.account ?? "";
  return !all.some((x) => x && x !== w && x.product === w.product && (x.account ?? "") === account && typeof x.usedPercent === "number");
}
