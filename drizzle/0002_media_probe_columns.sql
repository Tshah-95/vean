ALTER TABLE `media_assets` ADD `duration_sec` real;--> statement-breakpoint
ALTER TABLE `media_assets` ADD `fps_num` integer;--> statement-breakpoint
ALTER TABLE `media_assets` ADD `fps_den` integer;--> statement-breakpoint
ALTER TABLE `media_assets` ADD `width` integer;--> statement-breakpoint
ALTER TABLE `media_assets` ADD `height` integer;--> statement-breakpoint
ALTER TABLE `media_assets` ADD `audio_streams` integer;--> statement-breakpoint
ALTER TABLE `media_assets` ADD `color_space` text;--> statement-breakpoint
ALTER TABLE `media_assets` ADD `color_transfer` text;--> statement-breakpoint
ALTER TABLE `media_assets` ADD `color_primaries` text;--> statement-breakpoint
ALTER TABLE `media_assets` ADD `content_hash` text;--> statement-breakpoint
ALTER TABLE `media_assets` ADD `probed_at` text;