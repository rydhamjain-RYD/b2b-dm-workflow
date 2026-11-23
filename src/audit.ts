import { run } from "./db.ts";
import { now } from "./clock.ts";

export async function audit(actor: string, action: string, ref: string | null, detail?: unknown): Promise<void> {
  await run(
    "INSERT INTO audit (at, actor, action, ref, detail) VALUES ($1, $2, $3, $4, $5)",
    now(), actor, action, ref, detail === undefined ? null : JSON.stringify(detail),
  );
}

export async function raiseAlert(kind: string, message: string, ref: string | null = null): Promise<void> {
  await run("INSERT INTO alerts (kind, message, ref, created_at) VALUES ($1, $2, $3, $4)", kind, message, ref, now());
}
