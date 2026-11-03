import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';

const NOTES_LIMIT = 16000;
const VALUE_LIMIT = 2000;

function file(name: string): string {
  return path.join(loadConfig().stateDir, name);
}

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(name: string, value: unknown): void {
  fs.writeFileSync(file(name), JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export interface NotesRecord {
  content: string;
  chars: number;
  limit: number;
  updated_at: string | null;
}

export function readNotes(): NotesRecord {
  const record = readJson<NotesRecord>('notes.json', { content: '', chars: 0, limit: NOTES_LIMIT, updated_at: null });
  return { ...record, chars: record.content.length, limit: NOTES_LIMIT };
}

export function writeNotes(input: { content: string; mode?: 'replace' | 'append' }): NotesRecord {
  const current = readNotes();
  const mode = input.mode ?? 'replace';
  let content = mode === 'append' && current.content
    ? `${current.content}\n${input.content}`.trim()
    : input.content.trim();
  let truncated = false;
  if (content.length > NOTES_LIMIT) {
    content = content.slice(content.length - NOTES_LIMIT);
    truncated = true;
  }
  const record: NotesRecord = {
    content,
    chars: content.length,
    limit: NOTES_LIMIT,
    updated_at: new Date().toISOString()
  };
  writeJson('notes.json', record);
  return { ...record, chars: content.length, limit: NOTES_LIMIT, ...(truncated ? { truncated: true } as object : {}) } as NotesRecord;
}

export interface MemoryEntry {
  key: string;
  value: string;
  tags: string[];
  updated_at: string;
}

type MemoryStore = Record<string, MemoryEntry>;

export function readMemory(query?: string): { count: number; entries: MemoryEntry[] } {
  const store = readJson<MemoryStore>('memory.json', {});
  let entries = Object.values(store);
  if (query) {
    const needle = query.toLowerCase();
    entries = entries.filter((entry) =>
      entry.key.toLowerCase().includes(needle)
      || entry.value.toLowerCase().includes(needle)
      || entry.tags.some((tag) => tag.toLowerCase().includes(needle)));
  }
  entries.sort((a, b) => a.key.localeCompare(b.key));
  return { count: entries.length, entries };
}

export function writeMemory(input: { key: string; value: string; tags?: string[] }): MemoryEntry {
  const key = input.key.trim();
  if (!key) throw new Error('key must not be empty');
  if (input.value.length > VALUE_LIMIT) throw new Error(`value must be at most ${VALUE_LIMIT} characters`);
  const store = readJson<MemoryStore>('memory.json', {});
  const entry: MemoryEntry = {
    key,
    value: input.value.trim(),
    tags: (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean).slice(0, 8),
    updated_at: new Date().toISOString()
  };
  store[key] = entry;
  writeJson('memory.json', store);
  return entry;
}

export function deleteMemory(key: string): { deleted: boolean; key: string } {
  const store = readJson<MemoryStore>('memory.json', {});
  const existed = Object.prototype.hasOwnProperty.call(store, key);
  delete store[key];
  writeJson('memory.json', store);
  return { deleted: existed, key };
}

export interface JournalEntry {
  ts: string;
  type: string;
  text: string;
}

export function appendJournal(entry: { type?: string; text: string }): JournalEntry {
  const record: JournalEntry = {
    ts: new Date().toISOString(),
    type: entry.type ?? 'note',
    text: entry.text.trim()
  };
  fs.appendFileSync(file('journal.jsonl'), JSON.stringify(record) + '\n', 'utf8');
  return record;
}

export function readJournal(lastN = 30): { count: number; entries: JournalEntry[] } {
  try {
    const lines = fs.readFileSync(file('journal.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
    const entries = lines.slice(-Math.min(Math.max(lastN, 1), 500)).map((line) => {
      try { return JSON.parse(line) as JournalEntry; }
      catch { return { ts: '', type: 'corrupt', text: line }; }
    });
    return { count: entries.length, entries };
  } catch {
    return { count: 0, entries: [] };
  }
}
