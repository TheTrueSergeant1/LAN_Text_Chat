-- Create the main database if it doesn't exist and use it
DROP DATABASE IF EXISTS localchat_db;

CREATE DATABASE IF NOT EXISTS localchat_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE localchat_db;

-- 1. Users Table (Added Ban/Moderation fields)
CREATE TABLE IF NOT EXISTS users (
    user_id VARCHAR(36) PRIMARY KEY,
    username VARCHAR(20) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    user_role ENUM('Admin', 'Moderator', 'User') NOT NULL DEFAULT 'User',
    current_status ENUM('online', 'away', 'dnd') NOT NULL DEFAULT 'online',
    last_seen_channel VARCHAR(50) NOT NULL DEFAULT '#general',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- MODERATION / SECURITY PREP
    is_banned BOOLEAN DEFAULT FALSE,
    ban_reason VARCHAR(255) NULL,
    last_login_ip VARCHAR(45) NULL, -- For account protection
    
    UNIQUE KEY idx_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Channels Table (No change needed)
CREATE TABLE IF NOT EXISTS channels (
    channel_name VARCHAR(50) PRIMARY KEY,
    is_private BOOLEAN NOT NULL DEFAULT FALSE,
    invite_code VARCHAR(8) NULL UNIQUE,
    created_by VARCHAR(36),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    pinned_message_id VARCHAR(36) NULL,
    
    FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL,
    UNIQUE KEY idx_channel_name (channel_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO channels (channel_name, is_private) VALUES
    ('#general', FALSE),
    ('#dev-talk', FALSE),
    ('#random', FALSE);

-- 3. Messages Table (Added thread support)
CREATE TABLE IF NOT EXISTS messages (
    id VARCHAR(36) PRIMARY KEY,
    channel_name VARCHAR(50) NOT NULL,
    author_id VARCHAR(36) NOT NULL,
    author_username VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    edited BOOLEAN DEFAULT FALSE,
    edited_timestamp BIGINT NULL,
    attachment_metadata JSON NULL, 
    is_system BOOLEAN DEFAULT FALSE,
    
    -- THREADING PREP
    parent_message_id VARCHAR(36) NULL, -- Links to the root message of a thread (if reply)
    is_thread_root BOOLEAN DEFAULT FALSE, -- Optimization: Quickly find root messages
    
    FOREIGN KEY (channel_name) REFERENCES channels(channel_name) ON DELETE CASCADE,
    FOREIGN KEY (author_id) REFERENCES users(user_id) ON DELETE CASCADE,
    -- Self-referencing FK for threading. ON DELETE SET NULL allows the reply to remain if the parent is deleted.
    FOREIGN KEY (parent_message_id) REFERENCES messages(id) ON DELETE SET NULL, 

    -- INDEXES for Search, Threading, and History
    INDEX idx_channel_time (channel_name, timestamp DESC),
    FULLTEXT INDEX ft_content (content) -- Prep for full-text message search
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Reactions Table (No change needed)
CREATE TABLE IF NOT EXISTS reactions (
    message_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    emoji VARCHAR(10) NOT NULL,
    
    PRIMARY KEY (message_id, user_id, emoji),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Channel Members Table (No change needed)
CREATE TABLE IF NOT EXISTS channel_members (
    channel_name VARCHAR(50) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    PRIMARY KEY (channel_name, user_id),
    FOREIGN KEY (channel_name) REFERENCES channels(channel_name) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


--- NEW TABLES FOR ADVANCED FEATURES ---

-- 6. Read Receipts Table (For Durability/Presence)
CREATE TABLE IF NOT EXISTS read_receipts (
    message_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- 7. Audit Log (For Moderation and Security)
CREATE TABLE IF NOT EXISTS audit_logs (
    log_id INT AUTO_INCREMENT PRIMARY KEY,
    action_type VARCHAR(50) NOT NULL, -- e.g., 'MESSAGE_DELETE', 'USER_BAN', 'CHANNEL_CREATE'
    actor_id VARCHAR(36) NOT NULL,
    target_id VARCHAR(36) NULL, -- User/Message/Channel ID that was acted upon
    details JSON NULL,
    action_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (actor_id) REFERENCES users(user_id) ON DELETE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- 8. Channel Permissions (For Role-Based Access Control)
-- This table defines overrides for channels, moving towards granular RBAC.
CREATE TABLE IF NOT EXISTS channel_permissions (
    channel_name VARCHAR(50) NOT NULL,
    user_role ENUM('Admin', 'Moderator', 'User') NOT NULL,
    
    -- BOOLEAN FLAGS FOR GRANTED PERMISSIONS
    can_send_messages BOOLEAN NOT NULL DEFAULT TRUE,
    can_read_history BOOLEAN NOT NULL DEFAULT TRUE,
    can_manage_messages BOOLEAN NOT NULL DEFAULT FALSE, -- Edit/Delete others'
    can_invite BOOLEAN NOT NULL DEFAULT FALSE,
    can_pin BOOLEAN NOT NULL DEFAULT FALSE,
    
    PRIMARY KEY (channel_name, user_role),
    FOREIGN KEY (channel_name) REFERENCES channels(channel_name) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;