CREATE TABLE `loadouts` (
	`user_id` text NOT NULL,
	`idx` integer NOT NULL,
	`name` text NOT NULL,
	`primary_weapon` text,
	`primary_attachment` text,
	`secondary_weapon` text,
	`secondary_attachment` text,
	`modified_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `idx`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `selected_loadout` integer DEFAULT 0 NOT NULL;