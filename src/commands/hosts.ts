import { resolveBinary } from "../core/binary.ts";
import { HOSTS, hostById, type Host } from "../hosts/index.ts";
import { UserError } from "../core/errors.ts";

function selected(only?: string): readonly Host[] {
  if (!only) return HOSTS;
  const host = hostById(only);
  if (!host) {
    throw new UserError(`Unknown host "${only}"`, `Known hosts: ${HOSTS.map((h) => h.id).join(", ")}`);
  }
  return [host];
}

export async function installHooks(only?: string): Promise<string[]> {
  const binary = await resolveBinary();
  const log = [`Using: ${binary}`, ""];
  for (const host of selected(only)) {
    for (const root of await host.detectRoots()) {
      try {
        const result = await host.install(root, binary);
        const label = `${host.label} [${root.origin}] ${root.dir}`;
        if (result.installed.length) log.push(`✓ ${label}: ${result.installed.join(", ")}`);
        else log.push(`· ${label}: already up to date`);
        for (const note of result.manual) log.push(`  → ${note}`);
      } catch (error) {
        log.push(`✗ ${host.label} ${root.dir}: ${(error as Error).message}`);
      }
    }
  }
  return log;
}

export async function uninstallHooks(only?: string): Promise<string[]> {
  const log: string[] = [];
  for (const host of selected(only)) {
    for (const root of await host.detectRoots()) {
      try {
        const result = await host.uninstall(root);
        const label = `${host.label} [${root.origin}] ${root.dir}`;
        if (result.alreadyPresent.length) log.push(`✓ ${label}: removed ${result.alreadyPresent.join(", ")}`);
        else log.push(`· ${label}: nothing installed`);
        for (const b of result.backups) log.push(`  backup: ${b}`);
      } catch (error) {
        log.push(`✗ ${host.label} ${root.dir}: ${(error as Error).message}`);
      }
    }
  }
  return log;
}

/** `leftoff hosts doctor`: what is wired up, what is missing, what points elsewhere. */
export async function doctor(): Promise<{ lines: string[]; healthy: boolean }> {
  const binary = await resolveBinary();
  const lines = [`Leftoff binary: ${binary}`, ""];
  let healthy = true;

  for (const host of HOSTS) {
    const roots = await host.detectRoots();
    lines.push(`${host.label}:`);
    if (roots.length === 0) {
      lines.push("  (no config root found)");
      continue;
    }
    for (const root of roots) {
      const status = await host.status(root, binary);
      const mark = status.missing.length === 0 && status.stale.length === 0 ? "✓" : "✗";
      if (mark === "✗") healthy = false;
      lines.push(`  ${mark} ${root.dir}  (${root.origin})`);
      if (status.installed.length) lines.push(`      installed: ${status.installed.join(", ")}`);
      if (status.missing.length) lines.push(`      missing:   ${status.missing.join(", ")}`);
      for (const s of status.stale) lines.push(`      stale:     ${s}`);
    }
    lines.push("");
  }
  if (!healthy) lines.push("Run `leftoff hosts install` to fix what is missing.");
  return { lines, healthy };
}
