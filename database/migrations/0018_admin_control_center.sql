-- =====================================================================
--  0018 — Admin control centre, safe moderation states, reports,
--         account recovery, notifications and platform settings
--
--  Forward-only and additive: new columns default to today's behaviour,
--  new tables start empty except for rows copied from existing data.
--  Nothing is dropped except permissions that no code checks any more.
--  Back up first (npm run db:backup).
-- =====================================================================

-- Idempotent column helper (dropped again at the end of this migration).
DROP PROCEDURE IF EXISTS mig_0018_add_column;
DELIMITER $$
CREATE PROCEDURE mig_0018_add_column(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_ddl VARCHAR(500))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_table AND COLUMN_NAME = p_column) THEN
    SET @mig_sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_ddl);
    PREPARE mig_stmt FROM @mig_sql;
    EXECUTE mig_stmt;
    DEALLOCATE PREPARE mig_stmt;
  END IF;
END$$
DELIMITER ;

-- ---------------------------------------------------------------- 1. accounts
CALL mig_0018_add_column('users', 'must_change_password', 'TINYINT(1) NOT NULL DEFAULT 0');
CALL mig_0018_add_column('users', 'lock_reason', 'VARCHAR(200) NULL');
CALL mig_0018_add_column('users', 'deactivation_reason', 'VARCHAR(300) NULL');
CALL mig_0018_add_column('users', 'terms_version', 'VARCHAR(20) NULL');
CALL mig_0018_add_column('users', 'terms_accepted_at', 'DATETIME NULL');
CALL mig_0018_add_column('users', 'email_verified_at', 'DATETIME NULL');
CALL mig_0018_add_column('users', 'anonymised_at', 'DATETIME NULL');
CALL mig_0018_add_column('auth_sessions', 'reauth_at', 'DATETIME NULL');
ALTER TABLE auth_sessions MODIFY revoke_reason
  ENUM('LOGOUT','LOGOUT_ALL','PASSWORD_CHANGED','ADMIN_DEACTIVATED','REVOKED_BY_USER','ACCOUNT_DELETED',
       'IDLE_TIMEOUT','ADMIN_SIGNED_OUT','PASSWORD_RESET','ACCOUNT_ANONYMISED') NULL;

CREATE TABLE IF NOT EXISTS account_tokens (
  token_id    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED NOT NULL,
  purpose     ENUM('PASSWORD_RESET','EMAIL_VERIFY') NOT NULL,
  token_hash  CHAR(64) NOT NULL,
  created_by  INT UNSIGNED NULL,               -- an Admin who issued the link, or NULL for self-service
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL,
  PRIMARY KEY (token_id),
  UNIQUE KEY uq_account_tokens_hash (token_hash),
  KEY idx_account_tokens_user (user_id, purpose, used_at),
  CONSTRAINT fk_account_tokens_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE,
  CONSTRAINT fk_account_tokens_creator FOREIGN KEY (created_by) REFERENCES users (user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS notifications (
  notification_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED NOT NULL,
  kind            VARCHAR(40) NOT NULL,
  title           VARCHAR(140) NOT NULL,
  body            VARCHAR(600) NULL,
  link            VARCHAR(200) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at         DATETIME NULL,
  PRIMARY KEY (notification_id),
  KEY idx_notifications_user (user_id, read_at, notification_id),
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- 2. audit trail
CALL mig_0018_add_column('audit_logs', 'actor_label', 'VARCHAR(60) NULL');
CALL mig_0018_add_column('audit_logs', 'ip_hash', 'CHAR(64) NULL');
UPDATE audit_logs a JOIN users u ON u.user_id = a.actor_user_id SET a.actor_label = u.username WHERE a.actor_label IS NULL;
-- The audit ledger and upload history are insert-only for the application account.
REVOKE UPDATE, DELETE ON __DB__.artist_upload_events FROM '__APP_USER__'@'__APP_HOST__';

-- ---------------------------------------------------------------- 3. explicit song moderation states
-- status keeps its meaning (ACTIVE = published). moderation_state says WHY a song is not public,
-- so a generic "unhide" can never republish a recording that was suspended, taken down or withdrawn.
CALL mig_0018_add_column('songs', 'moderation_state', "ENUM('CLEAR','SUSPENDED','TAKEN_DOWN','WITHDRAWN') NOT NULL DEFAULT 'CLEAR'");
CALL mig_0018_add_column('songs', 'moderation_reason', 'VARCHAR(500) NULL');
CALL mig_0018_add_column('songs', 'moderated_by', 'INT UNSIGNED NULL');
CALL mig_0018_add_column('songs', 'moderated_at', 'DATETIME NULL');
CALL mig_0018_add_column('songs', 'description', 'VARCHAR(500) NULL');
CALL mig_0018_add_column('songs', 'artwork_file', 'VARCHAR(140) NULL');

-- Existing withdrawn or taken-down artist uploads keep their reason.
UPDATE songs s
  JOIN artist_uploads au ON au.song_id = s.song_id AND au.status = 'TAKEN_DOWN'
   SET s.moderation_state = IF(EXISTS (SELECT 1 FROM artist_upload_events e
                                        WHERE e.upload_id = au.upload_id AND e.event_code = 'ARTIST_WITHDRAWAL'),
                               'WITHDRAWN', 'TAKEN_DOWN'),
       s.moderation_reason = COALESCE(au.review_note, 'Removed before migration 0018.'),
       s.status = IF(s.status = 'ACTIVE', 'HIDDEN', s.status)
 WHERE s.moderation_state = 'CLEAR';

-- ---------------------------------------------------------------- 4. albums
CALL mig_0018_add_column('albums', 'status', "ENUM('PUBLISHED','UNPUBLISHED') NOT NULL DEFAULT 'PUBLISHED'");
CALL mig_0018_add_column('albums', 'description', 'VARCHAR(500) NULL');
CALL mig_0018_add_column('albums', 'artwork_file', 'VARCHAR(140) NULL');

-- ---------------------------------------------------------------- 5. artists
CALL mig_0018_add_column('artist_accounts', 'suspended_reason', 'VARCHAR(300) NULL');
CALL mig_0018_add_column('artist_accounts', 'suspended_at', 'DATETIME NULL');
CALL mig_0018_add_column('artist_accounts', 'suspended_by', 'INT UNSIGNED NULL');

CREATE TABLE IF NOT EXISTS artist_name_changes (
  request_id       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  artist_id        INT UNSIGNED NOT NULL,
  requested_by     INT UNSIGNED NULL,
  old_name         VARCHAR(100) NOT NULL,
  new_name         VARCHAR(100) NOT NULL,
  reason           VARCHAR(300) NULL,
  status           ENUM('PENDING','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  reviewer_user_id INT UNSIGNED NULL,
  review_note      VARCHAR(500) NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at      DATETIME NULL,
  PRIMARY KEY (request_id),
  KEY idx_name_changes_status (status, created_at),
  KEY idx_name_changes_artist (artist_id, status),
  CONSTRAINT fk_name_changes_artist FOREIGN KEY (artist_id) REFERENCES artists (artist_id) ON DELETE CASCADE,
  CONSTRAINT fk_name_changes_user FOREIGN KEY (requested_by) REFERENCES users (user_id) ON DELETE SET NULL,
  CONSTRAINT fk_name_changes_reviewer FOREIGN KEY (reviewer_user_id) REFERENCES users (user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- 6. uploads (Artist and Admin)
CALL mig_0018_add_column('artist_uploads', 'source', "ENUM('ARTIST','ADMIN') NOT NULL DEFAULT 'ARTIST'");
CALL mig_0018_add_column('artist_uploads', 'target_song_id', 'INT UNSIGNED NULL');
CALL mig_0018_add_column('artist_uploads', 'description', 'VARCHAR(500) NULL');
CALL mig_0018_add_column('artist_uploads', 'artwork_file', 'VARCHAR(140) NULL');
CALL mig_0018_add_column('artist_uploads', 'failure_reason', 'VARCHAR(500) NULL');
CALL mig_0018_add_column('artist_uploads', 'scan_attempts', 'TINYINT UNSIGNED NOT NULL DEFAULT 0');
CALL mig_0018_add_column('artist_uploads', 'next_scan_at', 'DATETIME NULL');

-- ---------------------------------------------------------------- 7. reports for every kind of content
CREATE TABLE IF NOT EXISTS content_reports (
  report_id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reporter_user_id   INT UNSIGNED NULL,
  target_type        ENUM('SONG','ARTIST','ALBUM','USER') NOT NULL,
  target_id          INT UNSIGNED NOT NULL,
  reason             ENUM('COPYRIGHT','IMPERSONATION','EXPLICIT_CONTENT','MISLABELLED','SAFETY','SPAM','HARASSMENT','OTHER') NOT NULL,
  details            VARCHAR(2000) NOT NULL,
  evidence_ref       VARCHAR(500) NULL,
  status             ENUM('OPEN','UNDER_REVIEW','RESOLVED','DISMISSED') NOT NULL DEFAULT 'OPEN',
  assigned_to        INT UNSIGNED NULL,
  resolution_action  VARCHAR(40) NULL,
  resolution_note    VARCHAR(500) NULL,
  legacy_rights_report_id BIGINT UNSIGNED NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  resolved_at        DATETIME NULL,
  PRIMARY KEY (report_id),
  UNIQUE KEY uq_content_reports_legacy (legacy_rights_report_id),
  KEY idx_content_reports_status (status, created_at),
  KEY idx_content_reports_target (target_type, target_id),
  KEY idx_content_reports_reporter (reporter_user_id, created_at),
  CONSTRAINT fk_content_reports_reporter FOREIGN KEY (reporter_user_id) REFERENCES users (user_id) ON DELETE SET NULL,
  CONSTRAINT fk_content_reports_assignee FOREIGN KEY (assigned_to) REFERENCES users (user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS content_report_notes (
  note_id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  report_id      BIGINT UNSIGNED NOT NULL,
  author_user_id INT UNSIGNED NULL,
  author_label   VARCHAR(60) NULL,
  body           VARCHAR(1000) NOT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (note_id),
  KEY idx_report_notes (report_id, created_at),
  CONSTRAINT fk_report_notes_report FOREIGN KEY (report_id) REFERENCES content_reports (report_id) ON DELETE CASCADE,
  CONSTRAINT fk_report_notes_author FOREIGN KEY (author_user_id) REFERENCES users (user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Existing rights reports become song reports (the report row itself is kept).
INSERT IGNORE INTO content_reports
  (reporter_user_id, target_type, target_id, reason, details, evidence_ref, status, assigned_to, resolution_note,
   legacy_rights_report_id, created_at, resolved_at)
SELECT rr.reporter_user_id, 'SONG', au.song_id, rr.report_type, rr.details, rr.evidence_ref, rr.status, rr.assigned_to,
       rr.resolution_note, rr.report_id, rr.created_at, rr.resolved_at
  FROM artist_rights_reports rr JOIN artist_uploads au ON au.upload_id = rr.upload_id
 WHERE au.song_id IS NOT NULL;

-- ---------------------------------------------------------------- 8. platform settings and editorial picks
CREATE TABLE IF NOT EXISTS platform_settings (
  setting_key   VARCHAR(40) NOT NULL,
  setting_value VARCHAR(500) NOT NULL,
  updated_by    INT UNSIGNED NULL,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key),
  CONSTRAINT fk_settings_user FOREIGN KEY (updated_by) REFERENCES users (user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS editorial_picks (
  pick_id     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  song_id     INT UNSIGNED NOT NULL,
  headline    VARCHAR(80) NOT NULL,
  note        VARCHAR(200) NULL,
  sort_order  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  starts_at   DATETIME NULL,
  ends_at     DATETIME NULL,
  created_by  INT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (pick_id),
  KEY idx_picks_window (starts_at, ends_at, sort_order),
  CONSTRAINT fk_picks_song FOREIGN KEY (song_id) REFERENCES songs (song_id) ON DELETE CASCADE,
  CONSTRAINT fk_picks_user FOREIGN KEY (created_by) REFERENCES users (user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- 9. shareable playlists
CALL mig_0018_add_column('playlists', 'share_token', 'CHAR(22) NULL');
SET @has_share_idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
                       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'playlists' AND INDEX_NAME = 'uq_playlists_share');
SET @share_sql = IF(@has_share_idx = 0, 'ALTER TABLE playlists ADD UNIQUE KEY uq_playlists_share (share_token)', 'DO 0');
PREPARE share_stmt FROM @share_sql;
EXECUTE share_stmt;
DEALLOCATE PREPARE share_stmt;

-- ---------------------------------------------------------------- 10. permissions
INSERT INTO permissions (permission_code, description) VALUES
  ('reports.manage', 'Review reports and take moderation actions'),
  ('settings.manage', 'Change platform settings and editorial picks'),
  ('media.manage', 'Upload, register, preview and remove LOOP-owned audio'),
  ('models.tune', 'Change recommender weights')
ON DUPLICATE KEY UPDATE description = VALUES(description);
INSERT IGNORE INTO role_permissions (role_id, permission_code)
SELECT r.role_id, p.code FROM roles r
  JOIN (SELECT 'reports.manage' AS code UNION ALL SELECT 'settings.manage' UNION ALL SELECT 'media.manage'
        UNION ALL SELECT 'models.tune' UNION ALL SELECT 'audit.view' UNION ALL SELECT 'users.manage'
        UNION ALL SELECT 'catalog.write' UNION ALL SELECT 'health.view' UNION ALL SELECT 'artist.review') p
 WHERE r.code = 'ADMIN';
-- Permissions for retired features guard nothing any more.
DELETE FROM role_permissions WHERE permission_code IN ('catalog.merge', 'review.decide', 'pipeline.view', 'pipeline.run');
DELETE FROM permissions WHERE permission_code IN ('catalog.merge', 'review.decide', 'pipeline.view', 'pipeline.run');

-- ---------------------------------------------------------------- 11. publication guard
-- A song can only become public (ACTIVE) when nothing holds it back and it has a sound profile,
-- whichever code path tries.
DROP TRIGGER IF EXISTS trg_songs_bu_publish_guard;
DELIMITER $$
CREATE TRIGGER trg_songs_bu_publish_guard BEFORE UPDATE ON songs
FOR EACH ROW
BEGIN
  IF NEW.status = 'ACTIVE' AND OLD.status <> 'ACTIVE' THEN
    IF NEW.moderation_state <> 'CLEAR' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This song was removed by moderation or by its artist; restore it explicitly instead';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM audio_features af WHERE af.song_id = NEW.song_id AND af.is_current = 1) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This song has no sound profile yet; add one before publishing it';
    END IF;
  END IF;
END$$
DELIMITER ;

-- ---------------------------------------------------------------- 12. catalogue view with artwork and moderation
CREATE OR REPLACE VIEW v_song_catalog AS
SELECT
  s.song_id, s.title, s.version_label, s.status, s.duration_sec, s.release_year, s.explicit,
  s.content_rating, s.popularity, s.isrc, s.moderation_state, s.description, s.track_number,
  COALESCE(s.artwork_file, al.artwork_file) AS artwork_file,
  a.artist_id, a.name AS artist_name, a.region_code AS artist_region,
  al.album_id, al.title AS album_title, al.album_type, f.film_id, f.title AS film_title,
  COALESCE(al.cover_color_1, g.color_hex) AS cover_color_1,
  COALESCE(al.cover_color_2, '#1F1B2E') AS cover_color_2,
  l.language_id, COALESCE(l.name, 'Instrumental') AS language_name,
  g.genre_id, g.name AS genre_name, g.color_hex AS genre_color,
  caf.energy, caf.valence, caf.danceability, caf.acousticness, caf.instrumentalness,
  caf.speechiness, caf.loudness_db, caf.tempo_bpm, caf.musical_key, caf.mode, caf.analysis_version,
  (SELECT GROUP_CONCAT(cm.mood_name ORDER BY cm.mood_rank SEPARATOR ',')
     FROM v_current_song_moods cm WHERE cm.song_id = s.song_id AND cm.mood_rank <= 3) AS mood_tags,
  pm.media_type AS playback_type, pm.source_code AS playback_source,
  pm.source_name AS playback_source_name, pm.media_type IS NOT NULL AS playable
FROM songs s
JOIN artists a ON a.artist_id = s.primary_artist_id
LEFT JOIN albums al ON al.album_id = s.album_id
LEFT JOIN films f ON f.film_id = al.film_id
LEFT JOIN languages l ON l.language_id = s.language_id
LEFT JOIN song_genres sg ON sg.song_id = s.song_id AND sg.is_primary = 1
LEFT JOIN genres g ON g.genre_id = sg.genre_id
LEFT JOIN v_current_audio_features caf ON caf.song_id = s.song_id
LEFT JOIN v_song_playback pm ON pm.song_id = s.song_id;

-- ---------------------------------------------------------------- 13. grants
GRANT SELECT, INSERT, UPDATE, DELETE ON __DB__.account_tokens TO '__APP_USER__'@'__APP_HOST__';
GRANT SELECT, INSERT, UPDATE, DELETE ON __DB__.notifications TO '__APP_USER__'@'__APP_HOST__';
GRANT SELECT, INSERT, UPDATE, DELETE ON __DB__.artist_name_changes TO '__APP_USER__'@'__APP_HOST__';
GRANT SELECT, INSERT, UPDATE ON __DB__.content_reports TO '__APP_USER__'@'__APP_HOST__';
GRANT SELECT, INSERT ON __DB__.content_report_notes TO '__APP_USER__'@'__APP_HOST__';
GRANT SELECT, INSERT, UPDATE, DELETE ON __DB__.platform_settings TO '__APP_USER__'@'__APP_HOST__';
GRANT SELECT, INSERT, UPDATE, DELETE ON __DB__.editorial_picks TO '__APP_USER__'@'__APP_HOST__';
GRANT SELECT, INSERT, UPDATE, DELETE ON __DB__.mood_keywords TO '__APP_USER__'@'__APP_HOST__';
GRANT SELECT, INSERT, UPDATE, DELETE ON __DB__.context_keywords TO '__APP_USER__'@'__APP_HOST__';

DROP PROCEDURE IF EXISTS mig_0018_add_column;
