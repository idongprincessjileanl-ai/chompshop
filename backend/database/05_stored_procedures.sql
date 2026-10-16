-- ChompCart | Group Garchomp | File 5: 6 stored procedures (requirement: at least 3)
USE chompcart;

DROP PROCEDURE IF EXISTS sp_place_order;
DROP PROCEDURE IF EXISTS sp_update_order_status;
DROP PROCEDURE IF EXISTS sp_get_sales_history;
DROP PROCEDURE IF EXISTS sp_save_forecast;
DROP PROCEDURE IF EXISTS sp_generate_restock_suggestions;
DROP PROCEDURE IF EXISTS sp_receive_restock;

DELIMITER $$

-- 1. CHECKOUT: order + items + payment in one transaction (all or nothing)
-- p_items example: '[{"product_id": 1, "quantity": 2}, {"product_id": 24, "quantity": 1}]'
CREATE PROCEDURE sp_place_order(
    IN  p_user_id         INT,
    IN  p_address_id      INT,
    IN  p_items           JSON,
    IN  p_payment_method  VARCHAR(10),
    OUT p_order_id        INT
)
BEGIN
    DECLARE v_item_count   INT DEFAULT 0;
    DECLARE v_unique_count INT DEFAULT 0;
    DECLARE v_valid_count  INT DEFAULT 0;
    DECLARE v_bad_qty      INT DEFAULT 0;
    DECLARE v_short_count  INT DEFAULT 0;
    DECLARE v_total        DECIMAL(10,2) DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;

    IF NOT EXISTS (SELECT 1 FROM users u JOIN roles r ON r.role_id = u.role_id
                   WHERE u.user_id = p_user_id AND u.is_active = TRUE AND r.role_name = 'Customer') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Only active customers can place orders';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM customer_addresses
                   WHERE address_id = p_address_id AND user_id = p_user_id) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Address does not belong to this user';
    END IF;

    SELECT COUNT(*), COUNT(DISTINCT j.product_id), SUM(j.quantity IS NULL OR j.quantity <= 0)
      INTO v_item_count, v_unique_count, v_bad_qty
      FROM JSON_TABLE(p_items, '$[*]' COLUMNS (
               product_id INT PATH '$.product_id',
               quantity   INT PATH '$.quantity')) AS j;

    IF v_item_count = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cart is empty';
    END IF;
    IF v_unique_count <> v_item_count THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The same product appears twice in the cart';
    END IF;
    IF v_bad_qty > 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Quantity must be greater than zero';
    END IF;

    SELECT COUNT(*) INTO v_valid_count
      FROM JSON_TABLE(p_items, '$[*]' COLUMNS (product_id INT PATH '$.product_id')) AS j
      JOIN products p ON p.product_id = j.product_id AND p.is_active = TRUE;
    IF v_valid_count <> v_item_count THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'One or more products are invalid or inactive';
    END IF;

    START TRANSACTION;

    SELECT COUNT(*) INTO v_short_count
      FROM JSON_TABLE(p_items, '$[*]' COLUMNS (
               product_id INT PATH '$.product_id',
               quantity   INT PATH '$.quantity')) AS j
      JOIN inventory i ON i.product_id = j.product_id
     WHERE i.quantity_on_hand < j.quantity
                 FOR UPDATE OF i;
    IF v_short_count > 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Not enough stock for one or more products';
    END IF;

    INSERT INTO orders (user_id, address_id, status) VALUES (p_user_id, p_address_id, 'PENDING');
    SET p_order_id = LAST_INSERT_ID();

    INSERT INTO order_items (order_id, product_id, quantity, unit_price)
    SELECT p_order_id, j.product_id, j.quantity, p.unit_price
      FROM JSON_TABLE(p_items, '$[*]' COLUMNS (
               product_id INT PATH '$.product_id',
               quantity   INT PATH '$.quantity')) AS j
      JOIN products p ON p.product_id = j.product_id;

    SELECT SUM(quantity * unit_price) INTO v_total FROM order_items WHERE order_id = p_order_id;

    INSERT INTO payments (order_id, payment_method, amount, payment_status)
    VALUES (p_order_id, p_payment_method, v_total, 'PENDING');

    COMMIT;

    SELECT p_order_id AS order_id, v_total AS total_amount, 'PENDING' AS status;
END$$

-- 2. ORDER STATUS: PENDING -> PAID/CANCELLED (or SHIPPED if COD), PAID -> SHIPPED/CANCELLED, SHIPPED -> DELIVERED
CREATE PROCEDURE sp_update_order_status(
    IN p_order_id    INT,
    IN p_new_status  VARCHAR(20),
    IN p_staff_id    INT
)
BEGIN
    DECLARE v_old_status VARCHAR(20);
    DECLARE v_method     VARCHAR(10);
    DECLARE v_msg        VARCHAR(255);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;

    START TRANSACTION;

    SELECT o.status, pay.payment_method INTO v_old_status, v_method
      FROM orders o
      JOIN payments pay ON pay.order_id = o.order_id
     WHERE o.order_id = p_order_id
       FOR UPDATE;

    IF v_old_status IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Order not found';
    END IF;

    IF NOT (   (v_old_status = 'PENDING' AND p_new_status IN ('PAID', 'CANCELLED'))
            OR (v_old_status = 'PENDING' AND p_new_status = 'SHIPPED' AND v_method = 'COD')
            OR (v_old_status = 'PAID'    AND p_new_status IN ('SHIPPED', 'CANCELLED'))
            OR (v_old_status = 'SHIPPED' AND p_new_status = 'DELIVERED') ) THEN
        SET v_msg = CONCAT('Cannot change order status from ', v_old_status, ' to ', p_new_status);
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    END IF;

    UPDATE orders SET status = p_new_status WHERE order_id = p_order_id;

    IF p_new_status = 'PAID' THEN
        UPDATE payments SET payment_status = 'COMPLETED', paid_at = NOW() WHERE order_id = p_order_id;

    ELSEIF p_new_status = 'DELIVERED' THEN
        UPDATE payments SET payment_status = 'COMPLETED', paid_at = COALESCE(paid_at, NOW())
         WHERE order_id = p_order_id;

    ELSEIF p_new_status = 'CANCELLED' THEN
        UPDATE inventory i
          JOIN order_items oi ON oi.product_id = i.product_id
           SET i.quantity_on_hand = i.quantity_on_hand + oi.quantity
         WHERE oi.order_id = p_order_id;

        INSERT INTO inventory_transactions (product_id, transaction_type, quantity, reference_note, performed_by)
        SELECT product_id, 'RETURN', quantity, CONCAT('Cancelled order #', p_order_id), p_staff_id
          FROM order_items WHERE order_id = p_order_id;

        UPDATE payments
           SET payment_status = IF(payment_status = 'COMPLETED', 'REFUNDED', 'FAILED')
         WHERE order_id = p_order_id;
    END IF;

    COMMIT;

    SELECT p_order_id AS order_id, v_old_status AS old_status, p_new_status AS new_status;
END$$

-- 3. SALES HISTORY for the AI model (weekly units per product). p_product_id = NULL means all products.
CREATE PROCEDURE sp_get_sales_history(
    IN p_product_id INT,
    IN p_weeks      INT
)
BEGIN
    SELECT
        DATE_SUB(DATE(o.order_date), INTERVAL WEEKDAY(o.order_date) DAY) AS week_start,
        p.product_id, p.sku, p.product_name,
        SUM(oi.quantity)                 AS units_sold,
        SUM(oi.quantity * oi.unit_price) AS revenue
    FROM orders o
    JOIN order_items oi ON oi.order_id  = o.order_id
    JOIN products    p  ON p.product_id = oi.product_id
    WHERE o.status <> 'CANCELLED'
      AND o.order_date >= DATE_SUB(CURDATE(), INTERVAL p_weeks WEEK)
      AND (p_product_id IS NULL OR p.product_id = p_product_id)
    GROUP BY week_start, p.product_id, p.sku, p.product_name
    ORDER BY p.product_id, week_start;
END$$

-- 4. SAVE FORECAST (called by the AI module; same product + start date + model updates the old row)
CREATE PROCEDURE sp_save_forecast(
    IN p_product_id  INT,
    IN p_start       DATE,
    IN p_end         DATE,
    IN p_quantity    INT,
    IN p_model_name  VARCHAR(50)
)
BEGIN
    INSERT INTO demand_forecasts (product_id, forecast_start, forecast_end, predicted_quantity, model_name)
    VALUES (p_product_id, p_start, p_end, p_quantity, p_model_name)
    ON DUPLICATE KEY UPDATE
        forecast_end       = p_end,
        predicted_quantity = p_quantity,
        created_at         = NOW();
END$$

-- 5. RESTOCK SUGGESTIONS from the latest AI forecast of each product
CREATE PROCEDURE sp_generate_restock_suggestions(
    IN p_staff_id INT
)
BEGIN
    INSERT INTO restock_requests (product_id, supplier_id, requested_by, quantity_requested, reason)
    SELECT p.product_id, p.supplier_id, p_staff_id,
           f.predicted_quantity + i.reorder_level - i.quantity_on_hand,
           CONCAT('AI forecast (', f.model_name, '): ', f.predicted_quantity,
                  ' units expected from ', f.forecast_start, ' to ', f.forecast_end)
    FROM demand_forecasts f
    JOIN products  p ON p.product_id = f.product_id
    JOIN inventory i ON i.product_id = f.product_id
    WHERE f.forecast_end >= CURDATE()
      AND f.forecast_id = (SELECT MAX(f2.forecast_id) FROM demand_forecasts f2
                            WHERE f2.product_id = f.product_id AND f2.forecast_end >= CURDATE())
      AND f.predicted_quantity + i.reorder_level > i.quantity_on_hand
      AND NOT EXISTS (SELECT 1 FROM restock_requests r
                       WHERE r.product_id = f.product_id
                         AND r.status IN ('PENDING', 'APPROVED', 'ORDERED'));

    SELECT ROW_COUNT() AS suggestions_created;

    SELECT r.restock_id, p.sku, p.product_name, r.quantity_requested, r.reason, r.created_at
      FROM restock_requests r
      JOIN products p ON p.product_id = r.product_id
     WHERE r.status = 'PENDING'
     ORDER BY r.created_at DESC;
END$$

-- 6. RECEIVE RESTOCK: mark as RECEIVED, add stock, log an IN transaction
CREATE PROCEDURE sp_receive_restock(
    IN p_restock_id INT,
    IN p_staff_id   INT
)
BEGIN
    DECLARE v_product_id INT;
    DECLARE v_quantity   INT;
    DECLARE v_status     VARCHAR(20);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;

    START TRANSACTION;

    SELECT product_id, quantity_requested, status INTO v_product_id, v_quantity, v_status
      FROM restock_requests WHERE restock_id = p_restock_id FOR UPDATE;

    IF v_product_id IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Restock request not found';
    END IF;
    IF v_status IN ('RECEIVED', 'REJECTED') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This restock request is already closed';
    END IF;

    UPDATE restock_requests SET status = 'RECEIVED' WHERE restock_id = p_restock_id;
    UPDATE inventory SET quantity_on_hand = quantity_on_hand + v_quantity WHERE product_id = v_product_id;

    INSERT INTO inventory_transactions (product_id, transaction_type, quantity, reference_note, performed_by)
    VALUES (v_product_id, 'IN', v_quantity, CONCAT('Restock #', p_restock_id), p_staff_id);

    COMMIT;

    SELECT p_restock_id AS restock_id, v_product_id AS product_id, v_quantity AS quantity_added;
END$$

DELIMITER ;

-- QUICK CHECK: should list 6 procedures
SHOW PROCEDURE STATUS WHERE Db = 'chompcart';