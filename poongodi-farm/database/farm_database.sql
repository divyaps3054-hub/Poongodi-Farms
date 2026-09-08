CREATE DATABASE IF NOT EXISTS poongodi_farm CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE poongodi_farm;

CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(190) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    profile_photo LONGTEXT DEFAULT NULL,
    role ENUM('admin','member') NOT NULL DEFAULT 'member',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE users MODIFY profile_photo LONGTEXT DEFAULT NULL;

CREATE TABLE IF NOT EXISTS daily_records (
    id INT AUTO_INCREMENT PRIMARY KEY,
    record_date DATE NOT NULL,
    quail_available DECIMAL(12,2) NOT NULL DEFAULT 0,
    quail_price DECIMAL(12,2) NOT NULL DEFAULT 0,
    quail_sold DECIMAL(12,2) NOT NULL DEFAULT 0,
    nattu_available DECIMAL(12,2) NOT NULL DEFAULT 0,
    nattu_price DECIMAL(12,2) NOT NULL DEFAULT 0,
    nattu_sold DECIMAL(12,2) NOT NULL DEFAULT 0,
    meat_available DECIMAL(12,2) NOT NULL DEFAULT 0,
    meat_price DECIMAL(12,2) NOT NULL DEFAULT 0,
    meat_sold DECIMAL(12,2) NOT NULL DEFAULT 0,
    mortality DECIMAL(12,2) NOT NULL DEFAULT 0,
    medicine DECIMAL(12,2) NOT NULL DEFAULT 0,
    tray_stickers DECIMAL(12,2) NOT NULL DEFAULT 0,
    expenses DECIMAL(12,2) NOT NULL DEFAULT 0,
    notes TEXT,
    updated_by INT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    quail_sales DECIMAL(14,2) AS (quail_price * quail_sold) STORED,
    nattu_sales DECIMAL(14,2) AS (nattu_price * nattu_sold) STORED,
    meat_sales DECIMAL(14,2) AS (meat_price * meat_sold) STORED,
    CONSTRAINT fk_records_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT chk_quail_stock CHECK (quail_available >= 0 AND quail_sold >= 0 AND quail_sold <= quail_available),
    CONSTRAINT chk_nattu_stock CHECK (nattu_available >= 0 AND nattu_sold >= 0 AND nattu_sold <= nattu_available),
    CONSTRAINT chk_meat_stock CHECK (meat_available >= 0 AND meat_sold >= 0 AND meat_sold <= meat_available)
);

ALTER TABLE daily_records ADD COLUMN IF NOT EXISTS mortality DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE daily_records ADD COLUMN IF NOT EXISTS medicine DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE daily_records ADD COLUMN IF NOT EXISTS tray_stickers DECIMAL(12,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS activity_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    action VARCHAR(255) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_activity_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Passwords are intentionally placeholders. Change them after importing.
INSERT IGNORE INTO users (name, email, password_hash, role) VALUES
('Prabakaran', 'prabakaran@poongodifarm.local', 'pbkdf2:sha256:600000$seed$placeholder', 'admin'),
('Poongodi', 'poongodi@poongodifarm.local', 'pbkdf2:sha256:600000$seed$placeholder', 'member'),
('Rajindharan', 'rajindharan@poongodifarm.local', 'pbkdf2:sha256:600000$seed$placeholder', 'member'),
('Sajindharan', 'sajindharan@poongodifarm.local', 'pbkdf2:sha256:600000$seed$placeholder', 'member');
