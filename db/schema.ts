import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

export const diagnosticRecordings = sqliteTable('diagnostic_recordings', {
  id: text('id').primaryKey(),
  manifest: text('manifest').notNull(),
  status: text('status', { enum: ['uploading', 'completed'] }).notNull(),
  createdAt: integer('created_at').notNull(),
  completedAt: integer('completed_at'),
  expiresAt: integer('expires_at').notNull(),
  uploadTokenHash: text('upload_token_hash').notNull(),
}, table => [index('diagnostic_recordings_status_expiry').on(table.status, table.expiresAt)]);

export const diagnosticChunks = sqliteTable('diagnostic_chunks', {
  recordingId: text('recording_id').notNull().references(() => diagnosticRecordings.id),
  chunkIndex: integer('chunk_index').notNull(),
  sha256: text('sha256').notNull(),
  compressedBytes: integer('compressed_bytes').notNull(),
  expandedBytes: integer('expanded_bytes').notNull(),
  eventCount: integer('event_count').notNull(),
  objectKey: text('object_key').notNull(),
  eventSummary: text('event_summary'),
}, table => [primaryKey({ columns: [table.recordingId, table.chunkIndex] })]);

export const diagnosticAuthFailures = sqliteTable('diagnostic_auth_failures', {
  ipHash: text('ip_hash').notNull(),
  attemptedAt: integer('attempted_at').notNull(),
}, table => [index('diagnostic_auth_failures_window').on(table.ipHash, table.attemptedAt)]);
