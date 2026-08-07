/** Session persistence — the app's own version-1 session JSON format. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as session from '../session.js';

export async function saveSession({ path }) {
    const state = await session.call('saveSession');
    const out = resolve(path);
    await writeFile(out, JSON.stringify(state, null, 2), 'utf8');
    return { path: out, shapes: state.drawings?.length ?? 0, savedAt: state.savedAt };
}

export async function loadSession({ path }) {
    const raw = await readFile(resolve(path), 'utf8');
    const state = JSON.parse(raw);
    if (state.version !== 1) throw new Error(`unsupported session version ${state.version} — restoreSession only accepts 1`);
    return session.call('loadSession', state);
}

export async function shareLink() {
    const link = await session.call('shareLink');
    if (!link) throw new Error('share link was not produced — is the session panel present?');
    return { link };
}
