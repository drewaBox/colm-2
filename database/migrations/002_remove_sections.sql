-- Permanently remove section fields and choices from student and validation records.
ALTER TABLE students DROP COLUMN section;
ALTER TABLE validation_records DROP COLUMN section;
DROP TABLE school_sections;

SET @drop_backup_section = (
	SELECT IF(COUNT(*) > 0, 'ALTER TABLE students_non_college_backup DROP COLUMN section', 'SELECT 1')
	FROM information_schema.COLUMNS
	WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'students_non_college_backup' AND COLUMN_NAME = 'section'
);
PREPARE remove_backup_section FROM @drop_backup_section;
EXECUTE remove_backup_section;
DEALLOCATE PREPARE remove_backup_section;