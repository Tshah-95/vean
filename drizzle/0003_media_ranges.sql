CREATE TABLE `media_collections` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`query_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_collections_project_name_unique` ON `media_collections` (`project_id`,`name`);--> statement-breakpoint
CREATE TABLE `media_ranges` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` text,
	`in_frame` integer,
	`out_frame` integer,
	`color` text,
	`notes` text,
	`provenance_json` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `media_assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `media_ranges_project_asset_idx` ON `media_ranges` (`project_id`,`asset_id`);--> statement-breakpoint
CREATE INDEX `media_ranges_project_kind_value_idx` ON `media_ranges` (`project_id`,`kind`,`value`);