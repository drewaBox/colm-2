-- Migration 003: audit display name for accounts, editable "processing" email message, receipt duplicate-check indexes.
-- Safe to run twice. Nothing is deleted. (The application also applies this by itself on the first request after upload.)

ALTER TABLE users ADD COLUMN IF NOT EXISTS audit_name VARCHAR(120) NULL AFTER full_name;

CREATE TABLE IF NOT EXISTS email_templates (
  template_key VARCHAR(40) PRIMARY KEY,
  subject VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_email_template_editor FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE payment_receipts ADD KEY IF NOT EXISTS idx_payment_receipts_file_hash (file_hash);
ALTER TABLE payment_receipts ADD KEY IF NOT EXISTS idx_payment_receipts_official_status (official_receipt_no, status);
