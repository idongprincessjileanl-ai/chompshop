-- ChompCart | Group Garchomp | File 11: saved cart per customer + AI fraud check for payments
-- Run AFTER File 10. Safe to run again.
-- If you ever run File 10 again, run this file again too (File 10 resets the customer account's permissions).
USE chompcart;

-- ===================== 1. SAVED CART =====================
-- Each customer's cart is kept in the database, so it is still there after logging out,
-- on another browser, or on another device.

CREATE TABLE IF NOT EXISTS cart_items (
    user_id     INT      NOT NULL,
    product_id  INT      NOT NULL,
    quantity    INT      NOT NULL DEFAULT 1,
    added_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, product_id),
    CONSTRAINT fk_cart_user    FOREIGN KEY (user_id)    REFERENCES users(user_id)       ON DELETE CASCADE,
    CONSTRAINT fk_cart_product FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE,
    CONSTRAINT chk_cart_qty CHECK (quantity BETWEEN 1 AND 99)
);

-- RLS policy: a customer only sees their own cart (tied to the logged-in user ID)
CREATE OR REPLACE SQL SECURITY DEFINER VIEW rls_cart_items AS
SELECT c.user_id, c.product_id, c.quantity, c.added_at, c.updated_at
FROM cart_items c
WHERE app_is_staff() OR c.user_id = app_user_id();

DROP PROCEDURE IF EXISTS sp_cart_save;
DELIMITER $$
-- Replaces the logged-in customer's whole cart.  p_items = [{"product_id":1,"quantity":2}, ...]
-- The user ID comes from app_user_id() (the login token), never from the caller.
CREATE PROCEDURE sp_cart_save(IN p_items JSON)
SQL SECURITY DEFINER
BEGIN
    DECLARE v_user INT DEFAULT app_user_id();
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;

    IF v_user IS NULL OR NOT app_is_customer() THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Only a logged-in customer can save a cart';
    END IF;

    START TRANSACTION;
    DELETE FROM cart_items WHERE user_id = v_user;
    IF p_items IS NOT NULL AND JSON_LENGTH(p_items) > 0 THEN
        INSERT INTO cart_items (user_id, product_id, quantity)
        SELECT v_user, j.product_id, LEAST(GREATEST(SUM(j.quantity), 1), 99)
        FROM JSON_TABLE(p_items, '$[*]' COLUMNS (
                 product_id INT PATH '$.product_id',
                 quantity   INT PATH '$.quantity')) AS j
        JOIN products p ON p.product_id = j.product_id
        WHERE j.quantity > 0
        GROUP BY j.product_id
        LIMIT 50;
    END IF;
    COMMIT;
END$$
DELIMITER ;

-- After a successful checkout, the bought products leave the saved cart
DROP TRIGGER IF EXISTS trg_cart_clear_after_order;
DELIMITER $$
CREATE TRIGGER trg_cart_clear_after_order
AFTER INSERT ON order_items
FOR EACH ROW
BEGIN
    DELETE c FROM cart_items c
    JOIN orders o ON o.order_id = NEW.order_id
    WHERE c.user_id = o.user_id AND c.product_id = NEW.product_id;
END$$
DELIMITER ;

-- ===================== 2. AI FRAUD CHECK FOR PAYMENTS =====================
-- The API scores every new order with a small machine-learning model (logistic regression,
-- trained on past orders) plus expert rules. Staff see the score before confirming payment.

CREATE TABLE IF NOT EXISTS payment_risk (
    order_id       INT          NOT NULL PRIMARY KEY,
    risk_score     TINYINT      NOT NULL,                 -- 0 (safe) to 100 (very risky)
    risk_level     ENUM('LOW','MEDIUM','HIGH') NOT NULL,
    reasons        VARCHAR(600) NULL,                     -- why the AI gave this score
    model_version  VARCHAR(40)  NOT NULL,
    checked_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    reviewed_by    INT          NULL,                     -- staff who approved a HIGH-risk payment
    reviewed_at    DATETIME     NULL,
    CONSTRAINT fk_risk_order    FOREIGN KEY (order_id)    REFERENCES orders(order_id) ON DELETE CASCADE,
    CONSTRAINT fk_risk_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(user_id),
    INDEX idx_risk_level (risk_level)
);

-- Customers do not see fraud scores; staff see all
CREATE OR REPLACE SQL SECURITY DEFINER VIEW rls_payment_risk AS
SELECT r.*
FROM payment_risk r
WHERE app_is_staff();

-- Summary for reports
CREATE OR REPLACE VIEW vw_payment_risk_summary AS
SELECT r.risk_level, COUNT(*) AS orders, ROUND(AVG(r.risk_score), 1) AS avg_score,
       SUM(o.status = 'CANCELLED') AS cancelled, SUM(o.status IN ('PAID','SHIPPED','DELIVERED')) AS paid_or_later
FROM payment_risk r
JOIN orders o ON o.order_id = r.order_id
GROUP BY r.risk_level;

-- ===================== 3. PERMISSIONS =====================
GRANT SELECT  ON chompcart.rls_cart_items TO 'chomp_customer'@'%';
GRANT EXECUTE ON PROCEDURE chompcart.sp_cart_save TO 'chomp_customer'@'%';
FLUSH PRIVILEGES;

-- ===================== CHECK =====================
SELECT 'cart_items' AS table_name, COUNT(*) AS total_rows FROM cart_items
UNION ALL SELECT 'payment_risk', COUNT(*) FROM payment_risk;
