import type { Backup, BackupShare, KrovaClient } from "@krovacloud/sdk";
import { Command } from "commander";

import { printJSON, printKeyValue, printTable } from "../lib/output.js";
import { getRuntime, makeClient, resolveSpace } from "../lib/runtime.js";

/**
 * Resolve a backup name-or-id to an id, the same rule as `resolveCube`: an
 * exact id wins; else exactly one exact name match; else a clear error.
 */
export async function resolveBackup(
  client: KrovaClient,
  spaceId: string,
  ref: string
): Promise<string> {
  const backups = await client.backups.list(spaceId);
  if (backups.some((b) => b.id === ref)) return ref;
  const byName = backups.filter((b) => b.name === ref);
  if (byName.length === 1) return byName[0]!.id;
  if (byName.length === 0) {
    throw new Error(
      `no backup named or with ID "${ref}" in this space (see \`krova backups list\`)`
    );
  }
  const ids = byName.map((b) => b.id).join(", ");
  throw new Error(
    `backup name "${ref}" is ambiguous: it matches ${byName.length} backups (${ids}) — use the backup ID instead`
  );
}

/** One row of `krova backups shares`: which way it goes, and the other space. */
export function shareRows(list: { incoming: BackupShare[]; outgoing: BackupShare[] }): string[][] {
  const row = (direction: string, s: BackupShare) => [
    s.id,
    direction,
    s.backupName,
    s.counterpartySpaceName,
    s.status,
    s.expiresAt,
  ];
  return [
    ...list.incoming.map((s) => row("incoming", s)),
    ...list.outgoing.map((s) => row("outgoing", s)),
  ];
}

function backupPairs(b: Backup): Array<[string, string]> {
  return [
    ["ID", b.id],
    ["Name", b.name],
    ["Status", b.status],
    ["From Cube", `${b.originalCubeName} (${b.originalCubeId})`],
    ["Size (bytes)", b.sizeBytes == null ? "" : String(b.sizeBytes)],
    ["Disk (GB)", String(b.diskSizeGb)],
    ["Shared from", b.sharedFromBackupId ?? ""],
    ["Created", b.createdAt],
  ];
}

/**
 * `krova backups` — list, download and share backups, and answer shares.
 *
 * Every subcommand needs the Backups permissions on the API key's member:
 * View Backups to read, Manage Backups for everything else.
 */
export function backupsCommand(): Command {
  const cmd = new Command("backups").description(
    "list, download and share backups, and answer backup shares"
  );

  cmd
    .command("list")
    .description("list this space's backups, newest first")
    .action(async (_opts, c: Command) => {
      const rt = getRuntime(c);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const backups = await client.backups.list(space);
      if (rt.json) return printJSON(backups);
      printTable(
        ["ID", "NAME", "STATUS", "SIZE (BYTES)", "SHARED FROM", "CREATED"],
        backups.map((b) => [
          b.id,
          b.name,
          b.status,
          b.sizeBytes == null ? "" : String(b.sizeBytes),
          b.sharedFromBackupId ?? "",
          b.createdAt,
        ]),
      );
    });

  cmd
    .command("get")
    .argument("<backup>", "backup name or ID")
    .description("show one backup")
    .action(async (ref: string, _opts, c: Command) => {
      const rt = getRuntime(c);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const backup = await client.backups.get(space, await resolveBackup(client, space, ref));
      if (rt.json) return printJSON(backup);
      printKeyValue(backupPairs(backup));
    });

  cmd
    .command("download")
    .argument("<backup>", "backup name or ID")
    .description("print a link to download the backup's .cube archive (valid for 15 minutes)")
    .action(async (ref: string, _opts, c: Command) => {
      const rt = getRuntime(c);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const link = await client.backups.download(space, await resolveBackup(client, space, ref));
      if (rt.json) return printJSON(link);
      if (!link) throw new Error("the API returned no download link");
      printKeyValue([
        ["URL", link.url ?? ""],
        ["File", link.filename ?? ""],
        ["Size (bytes)", link.sizeBytes == null ? "" : String(link.sizeBytes)],
        ["Expires", link.expiresAt ?? ""],
      ]);
      // The link needs no further authentication, and the archive is the whole disk.
      process.stderr.write(
        "Anyone with this link can download the archive until it expires. Do not paste it anywhere shared.\n"
      );
    });

  cmd
    .command("share")
    .argument("<backup>", "backup name or ID")
    .argument("<destination-space-id>", "the space to offer a copy to")
    .option("--idempotency-key <key>", "replaying the same key returns the original request")
    .description(
      "offer a copy of a backup to another space; it pays for its copy once it accepts (48 hours)"
    )
    .action(async (ref: string, destinationSpaceId: string, opts, c: Command) => {
      const rt = getRuntime(c);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const share = await client.backups.share(
        space,
        await resolveBackup(client, space, ref),
        { destinationSpaceId },
        opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined
      );
      if (rt.json) return printJSON(share);
      process.stdout.write(
        `Share ${share.id} requested. ${share.counterpartySpaceName} has until ${share.expiresAt} to accept.\n`
      );
    });

  cmd
    .command("shares")
    .description("list pending backup shares into and out of this space")
    .action(async (_opts, c: Command) => {
      const rt = getRuntime(c);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const list = await client.backupShares.list(space);
      if (rt.json) return printJSON(list);
      printTable(["ID", "DIRECTION", "BACKUP", "OTHER SPACE", "STATUS", "EXPIRES"], shareRows(list));
    });

  cmd
    .command("accept")
    .argument("<share-id>", "an incoming share (see `krova backups shares`)")
    .description("accept a backup shared with this space; its storage is billed to this space")
    .action(async (shareId: string, _opts, c: Command) => {
      const rt = getRuntime(c);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const accepted = await client.backupShares.accept(space, shareId);
      if (rt.json) return printJSON(accepted);
      process.stdout.write(
        `Accepted. The copy is backup ${accepted.backup.id} ("${accepted.backup.name}").\n`
      );
    });

  cmd
    .command("decline")
    .argument("<share-id>", "an incoming share (see `krova backups shares`)")
    .description("decline a backup shared with this space")
    .action(async (shareId: string, _opts, c: Command) => {
      const rt = getRuntime(c);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const share = await client.backupShares.decline(space, shareId);
      if (rt.json) return printJSON(share);
      process.stdout.write(`Declined share ${share.id}. Nothing was copied.\n`);
    });

  cmd
    .command("cancel")
    .argument("<share-id>", "an outgoing share (see `krova backups shares`)")
    .description("withdraw a pending share this space offered")
    .action(async (shareId: string, _opts, c: Command) => {
      const rt = getRuntime(c);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const share = await client.backupShares.cancel(space, shareId);
      if (rt.json) return printJSON(share);
      process.stdout.write(`Canceled share ${share.id}.\n`);
    });

  return cmd;
}
