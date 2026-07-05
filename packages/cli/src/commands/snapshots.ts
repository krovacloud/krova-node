import { Command } from "commander";

import { printJSON, printTable } from "../lib/output.js";
import { resolveCube } from "../lib/resolve.js";
import { getRuntime, makeClient, resolveSpace } from "../lib/runtime.js";

/** `krova snapshots` — snapshot and restore a Cube's disk. */
export function snapshotsCommand(): Command {
  const cmd = new Command("snapshots").description("snapshot and restore a Cube's disk");

  cmd
    .command("list")
    .argument("<cube>", "cube name or ID")
    .description("list a Cube's snapshots")
    .action(async (cubeRef: string, _opts, c: Command) => {
      const rt = getRuntime(c);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const id = await resolveCube(client, space, cubeRef);
      const snaps = await client.snapshots.list(space, id);
      if (rt.json) return printJSON(snaps);
      printTable(
        ["ID", "NAME", "STATUS", "KIND", "SIZE (BYTES)", "CREATED"],
        snaps.map((s) => [
          s.id,
          s.name,
          s.status,
          s.kind,
          s.sizeBytes == null ? "" : String(s.sizeBytes),
          s.createdAt,
        ]),
      );
    });

  cmd
    .command("create")
    .argument("<cube>", "cube name or ID")
    .option("--name <name>", "a name for the snapshot")
    .description("create a snapshot of a Cube's disk")
    .action(async (cubeRef: string, opts, c: Command) => {
      const rt = getRuntime(c);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const id = await resolveCube(client, space, cubeRef);
      const snap = await client.snapshots.create(space, id, opts.name ? { name: opts.name } : {});
      if (rt.json) return printJSON(snap);
      process.stdout.write(`Created snapshot ${snap.id} (${snap.status})\n`);
    });

  cmd
    .command("rm")
    .argument("<cube>", "cube name or ID")
    .argument("<snapshot-id>", "the snapshot ID (see `krova snapshots list`)")
    .description("delete a snapshot")
    .action(async (cubeRef: string, snapshotId: string, _opts, c: Command) => {
      const rt = getRuntime(c);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const id = await resolveCube(client, space, cubeRef);
      await client.snapshots.delete(space, id, snapshotId);
      if (rt.json) return printJSON({ id: snapshotId, result: "deleted" });
      process.stdout.write(`Deleted snapshot ${snapshotId}\n`);
    });

  cmd
    .command("restore")
    .argument("<cube>", "cube name or ID")
    .argument("<snapshot-id>", "the snapshot to restore the Cube's disk from")
    .description("restore a Cube's disk from one of its snapshots (replaces the disk)")
    .action(async (cubeRef: string, snapshotId: string, _opts, c: Command) => {
      const rt = getRuntime(c);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const id = await resolveCube(client, space, cubeRef);
      await client.cubes.restore(space, id, snapshotId);
      if (rt.json) return printJSON({ id, snapshotId, result: "restore enqueued" });
      process.stdout.write(`Restore of cube ${id} from ${snapshotId} enqueued\n`);
    });

  return cmd;
}
