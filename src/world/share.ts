/**
 * Opt-in sharing of visitors' maps with the developer, for inspiration. It uses the published
 * page's own database: each visitor writes only under their own id, and only the page's owner
 * can read what was shared. Elsewhere (a local build, GitHub Pages) there is no database and
 * the page simply doesn't offer sharing.
 */

/** Documents are capped at 256 KiB; leave room for the fields around the map. */
export const MAX_SHARE_BYTES = 200_000;

export interface Sharing {
  share(id: string, map: Record<string, unknown>): Promise<void>;
}

interface Db {
  doc(path: string): { set(data: Record<string, unknown>): Promise<void> };
}
interface User {
  id(): Promise<string | null>;
  can(capability: string): Promise<boolean | null>;
}
interface Claude {
  use(name: string): Promise<unknown>;
}

export async function startSharing(): Promise<Sharing | null> {
  const claude = (window as unknown as { claude?: Claude }).claude;
  if (!claude?.use) return null;
  try {
    const [db, user] = (await Promise.all([claude.use("db"), claude.use("user")])) as [Db | null, User | null];
    if (!db || !user) return null;
    // Viewers who can only look at the page can't write; don't offer what would fail.
    if ((await user.can("data.write")) === false) return null;
    const uid = await user.id();
    if (!uid) return null;
    return { share: (id, map) => db.doc(`shared_maps/${uid}/maps/${id}`).set(map) };
  } catch {
    return null;
  }
}
