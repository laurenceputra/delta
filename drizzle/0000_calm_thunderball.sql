CREATE TABLE `diagnostic_auth_failures` (
	`ip_hash` text NOT NULL,
	`attempted_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `diagnostic_auth_failures_window` ON `diagnostic_auth_failures` (`ip_hash`,`attempted_at`);--> statement-breakpoint
CREATE TABLE `diagnostic_chunks` (
	`recording_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`sha256` text NOT NULL,
	`compressed_bytes` integer NOT NULL,
	`expanded_bytes` integer NOT NULL,
	`event_count` integer NOT NULL,
	`object_key` text NOT NULL,
	PRIMARY KEY(`recording_id`, `chunk_index`),
	FOREIGN KEY (`recording_id`) REFERENCES `diagnostic_recordings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `diagnostic_recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`manifest` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	`expires_at` integer NOT NULL,
	`upload_token_hash` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `diagnostic_recordings_status_expiry` ON `diagnostic_recordings` (`status`,`expires_at`);