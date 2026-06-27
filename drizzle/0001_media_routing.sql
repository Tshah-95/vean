CREATE TABLE `media_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`root_id` text NOT NULL,
	`path` text NOT NULL,
	`relative_path` text NOT NULL,
	`kind` text DEFAULT 'unknown' NOT NULL,
	`size_bytes` integer,
	`mtime_ms` integer,
	`labels_json` text DEFAULT '[]' NOT NULL,
	`probe_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`root_id`) REFERENCES `media_roots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_assets_project_path_unique` ON `media_assets` (`project_id`,`path`);--> statement-breakpoint
CREATE INDEX `media_assets_project_kind_idx` ON `media_assets` (`project_id`,`kind`);--> statement-breakpoint
CREATE TABLE `media_roots` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`role` text DEFAULT 'raw' NOT NULL,
	`path` text NOT NULL,
	`policy_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_roots_project_role_path_unique` ON `media_roots` (`project_id`,`role`,`path`);--> statement-breakpoint
CREATE TABLE `route_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`alias` text NOT NULL,
	`target` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `route_aliases_project_alias_unique` ON `route_aliases` (`project_id`,`alias`);