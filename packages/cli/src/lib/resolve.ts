import type { KrovaClient } from "@krovacloud/sdk";

/** Resolve a cube name-or-id to an id (parity with the Go resolveCube):
 *  exact id wins; else exactly one exact name match; else a clear error. */
export async function resolveCube(
  client: KrovaClient,
  spaceId: string,
  ref: string
): Promise<string> {
  const { cubes } = await client.cubes.list(spaceId);
  if (cubes.some((c) => c.id === ref)) return ref;
  const byName = cubes.filter((c) => c.name === ref);
  if (byName.length === 1) return byName[0]!.id;
  if (byName.length === 0) {
    throw new Error(
      `no cube named or with ID "${ref}" in this space (see \`krova cubes list\`)`
    );
  }
  const ids = byName.map((c) => c.id).join(", ");
  throw new Error(
    `cube name "${ref}" is ambiguous: it matches ${byName.length} cubes (${ids}) — use the cube ID instead`
  );
}
