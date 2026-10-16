-- ChompCart | Group Garchomp | File 10: login accounts, row-level security (RLS), audit and error logs
-- Run AFTER File 9 (before File 7). Safe to run again. If you re-run File 9, run this file again too.
--
-- MySQL has no built-in RLS (that is a PostgreSQL feature), so this file builds the same idea:
--   1. The API tells MySQL who is logged in:   SET @app_user_id = 12, @app_role = 'Customer';
--   2. app_user_id() / app_role() read that value inside the database.
--   3. "RLS views" (rls_*) only return the rows that user is allowed to see (the policies).
--   4. RLS triggers block writes that pretend to be another user.
--   5. The customer database account can ONLY read the rls_* views, never the raw tables.
USE chompcart;

-- ===================== 1. ROLES AND ACCOUNTS =====================

INSERT INTO roles (role_id, role_name, description) VALUES
(4, 'Rider', 'Delivers orders and uploads proof of delivery')
ON DUPLICATE KEY UPDATE description = VALUES(description);

DROP PROCEDURE IF EXISTS tmp_add_column;
DELIMITER $$
-- Adds a column only if it does not exist yet (so this file can be run again)
CREATE PROCEDURE tmp_add_column(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_definition VARCHAR(500))
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = DATABASE() AND table_name = p_table AND column_name = p_column) THEN
        SET @ddl = CONCAT('ALTER TABLE ', p_table, ' ADD COLUMN ', p_column, ' ', p_definition);
        PREPARE stmt FROM @ddl;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END$$
DELIMITER ;

-- Login protection: lock an account for 15 minutes after 5 wrong passwords
CALL tmp_add_column('users', 'failed_logins', 'INT NOT NULL DEFAULT 0');
CALL tmp_add_column('users', 'locked_until',  'DATETIME NULL');
CALL tmp_add_column('users', 'last_login_at', 'DATETIME NULL');

-- Each rider gets a login account
CALL tmp_add_column('drivers', 'user_id', 'INT NULL UNIQUE AFTER driver_id');
DROP PROCEDURE tmp_add_column;

-- Rider accounts (the API replaces this placeholder with a real bcrypt hash on first start)
INSERT IGNORE INTO users (role_id, first_name, last_name, email, password_hash, phone, created_at)
SELECT 4, SUBSTRING_INDEX(full_name, ' ', 1), SUBSTRING_INDEX(full_name, ' ', -1),
       CONCAT('rider', driver_id, '@chompcart.example'),
       '$2b$10$REPLACE.WITH.REAL.BCRYPT.HASH.FROM.BACKEND.TEAM.0000000',
       phone, created_at
FROM drivers;

UPDATE drivers d
JOIN users u ON u.email = CONCAT('rider', d.driver_id, '@chompcart.example')
SET d.user_id = u.user_id;

SET @fk_exists = (SELECT COUNT(*) FROM information_schema.table_constraints
                   WHERE table_schema = DATABASE() AND table_name = 'drivers'
                     AND constraint_name = 'fk_drivers_user');
SET @ddl = IF(@fk_exists = 0,
    'ALTER TABLE drivers ADD CONSTRAINT fk_drivers_user FOREIGN KEY (user_id) REFERENCES users(user_id)',
    'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ===================== 2. AUDIT AND ERROR LOGS (2 new tables, 20 total) =====================

-- Who did what: logins, checkouts, status changes, edits
CREATE TABLE IF NOT EXISTS audit_log (
    audit_id    BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id     INT NULL,
    role_name   VARCHAR(30) NULL,
    action      VARCHAR(50)  NOT NULL,
    entity      VARCHAR(50)  NULL,
    entity_id   VARCHAR(50)  NULL,
    details     JSON NULL,
    ip_address  VARCHAR(45)  NULL,
    request_id  VARCHAR(36)  NULL,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_created (created_at),
    INDEX idx_audit_user (user_id)
);

-- Server errors, so they can be reviewed later (error tracking)
CREATE TABLE IF NOT EXISTS error_log (
    error_id    BIGINT AUTO_INCREMENT PRIMARY KEY,
    request_id  VARCHAR(36)  NULL,
    method      VARCHAR(10)  NULL,
    path        VARCHAR(255) NULL,
    status      SMALLINT     NOT NULL,
    message     VARCHAR(1000) NOT NULL,
    stack       TEXT NULL,
    user_id     INT NULL,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_error_created (created_at)
);

-- ===================== 3. WHO IS LOGGED IN =====================

DROP FUNCTION IF EXISTS app_user_id;
DROP FUNCTION IF EXISTS app_role;
DROP FUNCTION IF EXISTS app_is_staff;
DROP FUNCTION IF EXISTS app_is_rider;
DROP FUNCTION IF EXISTS app_is_customer;

DELIMITER $$

-- The logged-in user's ID, set by the API for every request (NULL = not logged in)
CREATE FUNCTION app_user_id() RETURNS INT
NOT DETERMINISTIC NO SQL
RETURN @app_user_id$$

-- The logged-in user's role: Admin, Inventory Staff, Customer or Rider
CREATE FUNCTION app_role() RETURNS VARCHAR(30)
NOT DETERMINISTIC NO SQL
RETURN @app_role$$

-- Role checks compare bytes (BINARY), so they work whatever the text collation of the connection is
CREATE FUNCTION app_is_staff() RETURNS BOOLEAN
NOT DETERMINISTIC NO SQL
RETURN CAST(@app_role AS BINARY) IN (BINARY 'Admin', BINARY 'Inventory Staff')$$

CREATE FUNCTION app_is_rider() RETURNS BOOLEAN
NOT DETERMINISTIC NO SQL
RETURN CAST(@app_role AS BINARY) = BINARY 'Rider'$$

CREATE FUNCTION app_is_customer() RETURNS BOOLEAN
NOT DETERMINISTIC NO SQL
RETURN CAST(@app_role AS BINARY) = BINARY 'Customer'$$

DELIMITER ;

-- ===================== 4. RLS POLICIES (views) =====================
-- Policy                     | Who sees which rows
-- rls_orders                 | staff: all | customer: own orders | rider: orders assigned to them
-- rls_order_items            | items of the orders above
-- rls_payments               | payments of the orders above
-- rls_customer_addresses     | staff: all | customer: own | rider: addresses of their deliveries
-- rls_users                  | staff: all | everyone else: only themselves (no password hash)
-- rls_deliveries             | deliveries of the orders above, with rider details
-- rls_driver_ratings         | staff: all | customer: own | rider: ratings about them
-- rls_my_reviews             | staff: all | customer: own product reviews

CREATE OR REPLACE SQL SECURITY DEFINER VIEW rls_orders AS
SELECT o.*
FROM orders o
WHERE app_is_staff()
   OR o.user_id = app_user_id()
   OR (app_is_rider() AND EXISTS (
           SELECT 1 FROM deliveries dl JOIN drivers d ON d.driver_id = dl.driver_id
            WHERE dl.order_id = o.order_id AND d.user_id = app_user_id()));

CREATE OR REPLACE SQL SECURITY DEFINER VIEW rls_order_items AS
SELECT oi.*
FROM order_items oi
JOIN rls_orders o ON o.order_id = oi.order_id;

CREATE OR REPLACE SQL SECURITY DEFINER VIEW rls_payments AS
SELECT pay.*
FROM payments pay
JOIN rls_orders o ON o.order_id = pay.order_id;

CREATE OR REPLACE SQL SECURITY DEFINER VIEW rls_customer_addresses AS
SELECT a.*
FROM customer_addresses a
WHERE app_is_staff()
   OR a.user_id = app_user_id()
   OR a.address_id IN (SELECT address_id FROM rls_orders);

CREATE OR REPLACE SQL SECURITY DEFINER VIEW rls_users AS
SELECT u.user_id, u.role_id, r.role_name, u.first_name, u.last_name, u.email, u.phone, u.is_active, u.created_at
FROM users u
JOIN roles r ON r.role_id = u.role_id
WHERE app_is_staff() OR u.user_id = app_user_id();

CREATE OR REPLACE SQL SECURITY DEFINER VIEW rls_deliveries AS
SELECT dl.*, d.full_name AS driver_name, d.phone AS driver_phone, d.vehicle, d.plate_no
FROM deliveries dl
JOIN drivers d     ON d.driver_id = dl.driver_id
JOIN rls_orders o  ON o.order_id  = dl.order_id;

CREATE OR REPLACE SQL SECURITY DEFINER VIEW rls_driver_ratings AS
SELECT dr.*
FROM driver_ratings dr
JOIN drivers d ON d.driver_id = dr.driver_id
WHERE app_is_staff()
   OR dr.user_id = app_user_id()
   OR (app_is_rider() AND d.user_id = app_user_id());

CREATE OR REPLACE SQL SECURITY DEFINER VIEW rls_my_reviews AS
SELECT r.*
FROM product_reviews r
WHERE app_is_staff() OR r.user_id = app_user_id();

-- Public, non-personal summary for "frequently bought together" (no customer data)
CREATE OR REPLACE SQL SECURITY DEFINER VIEW vw_bought_together AS
SELECT a.product_id, b.product_id AS other_product_id, COUNT(*) AS times_bought_together
FROM order_items a
JOIN order_items b ON b.order_id = a.order_id AND b.product_id <> a.product_id
GROUP BY a.product_id, b.product_id;

-- ===================== 5. RLS ON WRITES (triggers) =====================

DROP TRIGGER IF EXISTS trg_orders_rls_insert;
DROP TRIGGER IF EXISTS trg_reviews_rls_insert;
DROP TRIGGER IF EXISTS trg_driver_ratings_rls_insert;
DROP TRIGGER IF EXISTS trg_deliveries_rls_update;

DELIMITER $$

-- A customer can only place orders for themselves
CREATE TRIGGER trg_orders_rls_insert
BEFORE INSERT ON orders
FOR EACH ROW
BEGIN
    IF app_is_customer() AND NEW.user_id <> app_user_id() THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RLS: you can only place orders for your own account';
    END IF;
END$$

-- A customer can only write reviews as themselves
CREATE TRIGGER trg_reviews_rls_insert
BEFORE INSERT ON product_reviews
FOR EACH ROW FOLLOWS trg_reviews_before_insert
BEGIN
    IF app_role() IS NOT NULL AND NOT app_is_staff() AND NEW.user_id <> app_user_id() THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RLS: you can only review as yourself';
    END IF;
END$$

-- A customer can only rate riders as themselves
CREATE TRIGGER trg_driver_ratings_rls_insert
BEFORE INSERT ON driver_ratings
FOR EACH ROW FOLLOWS trg_driver_ratings_before_insert
BEGIN
    IF app_role() IS NOT NULL AND NOT app_is_staff() AND NEW.user_id <> app_user_id() THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RLS: you can only rate as yourself';
    END IF;
END$$

-- A rider can only update (deliver) their own deliveries
CREATE TRIGGER trg_deliveries_rls_update
BEFORE UPDATE ON deliveries
FOR EACH ROW
BEGIN
    IF app_is_rider() AND NOT EXISTS (
           SELECT 1 FROM drivers WHERE driver_id = OLD.driver_id AND user_id = app_user_id()) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RLS: riders can only update their own deliveries';
    END IF;
END$$

DELIMITER ;

-- ===================== 6. DATABASE ACCOUNTS (least privilege) =====================
-- chomp_customer: used for shoppers and visitors. It can NOT read the raw orders/users tables,
--                 only the rls_* views, so even a bug in the API cannot leak other customers' data.
-- chomp_staff:    used for staff, riders and admin. Read/write data, but cannot drop or alter tables.
-- Change these passwords, then put the same ones in .env (DB_CUSTOMER_PASSWORD / DB_STAFF_PASSWORD).

CREATE USER IF NOT EXISTS 'chomp_customer'@'%' IDENTIFIED BY 'Chomp-Customer-2026!';
ALTER USER 'chomp_customer'@'%' IDENTIFIED BY 'Chomp-Customer-2026!';
CREATE USER IF NOT EXISTS 'chomp_staff'@'%' IDENTIFIED BY 'Chomp-Staff-2026!';
ALTER USER 'chomp_staff'@'%' IDENTIFIED BY 'Chomp-Staff-2026!';

-- Start from zero, then grant only what is needed
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'chomp_customer'@'%';
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'chomp_staff'@'%';

-- Customer / visitor: public catalog
GRANT SELECT ON chompcart.vw_product_catalog       TO 'chomp_customer'@'%';
GRANT SELECT ON chompcart.vw_top_selling_products  TO 'chomp_customer'@'%';
GRANT SELECT ON chompcart.vw_bought_together       TO 'chomp_customer'@'%';
GRANT SELECT ON chompcart.products                 TO 'chomp_customer'@'%';
GRANT SELECT ON chompcart.categories               TO 'chomp_customer'@'%';
GRANT SELECT ON chompcart.suppliers                TO 'chomp_customer'@'%';
GRANT SELECT ON chompcart.product_specifications   TO 'chomp_customer'@'%';
-- Customer: only their own rows, through the RLS views
GRANT SELECT ON chompcart.rls_orders               TO 'chomp_customer'@'%';
GRANT SELECT ON chompcart.rls_order_items          TO 'chomp_customer'@'%';
GRANT SELECT ON chompcart.rls_payments             TO 'chomp_customer'@'%';
GRANT SELECT ON chompcart.rls_customer_addresses   TO 'chomp_customer'@'%';
GRANT SELECT ON chompcart.rls_users                TO 'chomp_customer'@'%';
GRANT SELECT ON chompcart.rls_deliveries           TO 'chomp_customer'@'%';
GRANT SELECT ON chompcart.rls_driver_ratings       TO 'chomp_customer'@'%';
GRANT SELECT ON chompcart.rls_my_reviews           TO 'chomp_customer'@'%';
-- Customer: checkout and feedback (triggers check ownership)
GRANT EXECUTE ON PROCEDURE chompcart.sp_place_order TO 'chomp_customer'@'%';
GRANT INSERT ON chompcart.product_reviews          TO 'chomp_customer'@'%';
GRANT INSERT ON chompcart.driver_ratings           TO 'chomp_customer'@'%';

-- Staff, riders, admin: day-to-day data work, no schema changes
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON chompcart.* TO 'chomp_staff'@'%';

FLUSH PRIVILEGES;

-- ===================== CHECK =====================
SELECT r.role_name, COUNT(u.user_id) AS accounts
FROM roles r LEFT JOIN users u ON u.role_id = r.role_id
GROUP BY r.role_id, r.role_name ORDER BY r.role_id;

SELECT d.driver_id, d.full_name, u.email AS login_email
FROM drivers d LEFT JOIN users u ON u.user_id = d.user_id ORDER BY d.driver_id;

-- RLS demo: as customer 4 you only see customer 4's orders
SET @app_user_id = 4, @app_role = 'Customer';
SELECT 'customer 4 sees' AS who, COUNT(*) AS orders, COUNT(DISTINCT user_id) AS different_customers FROM rls_orders;
SET @app_user_id = NULL, @app_role = NULL;
SELECT 'not logged in sees' AS who, COUNT(*) AS orders FROM rls_orders;
SET @app_user_id = 1, @app_role = 'Admin';
SELECT 'admin sees' AS who, COUNT(*) AS orders FROM rls_orders;
SET @app_user_id = NULL, @app_role = NULL;

SELECT 'tables (should be 20)' AS item, COUNT(*) AS total FROM information_schema.tables
WHERE table_schema = 'chompcart' AND table_type = 'BASE TABLE';
