-- ChompCart | Group Garchomp | File 6: 4 triggers (requirement: at least 2)
-- Run this AFTER File 3, so the old sample orders do not deduct stock again.
USE chompcart;

DROP TRIGGER IF EXISTS trg_order_items_before_insert;
DROP TRIGGER IF EXISTS trg_order_items_after_insert;
DROP TRIGGER IF EXISTS trg_inventory_after_update;
DROP TRIGGER IF EXISTS trg_reviews_before_insert;

DELIMITER $$

-- 1. Block the sale if there is not enough stock
CREATE TRIGGER trg_order_items_before_insert
BEFORE INSERT ON order_items
FOR EACH ROW
BEGIN
    DECLARE v_stock INT DEFAULT 0;
    DECLARE v_msg   VARCHAR(255);

    SELECT quantity_on_hand INTO v_stock FROM inventory WHERE product_id = NEW.product_id;

    IF v_stock < NEW.quantity THEN
        SET v_msg = CONCAT('Not enough stock for product ID ', NEW.product_id,
                           ' (available: ', v_stock, ', requested: ', NEW.quantity, ')');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    END IF;
END$$

-- 2. Deduct stock and record the movement
CREATE TRIGGER trg_order_items_after_insert
AFTER INSERT ON order_items
FOR EACH ROW
BEGIN
    UPDATE inventory
       SET quantity_on_hand = quantity_on_hand - NEW.quantity
     WHERE product_id = NEW.product_id;

    INSERT INTO inventory_transactions (product_id, transaction_type, quantity, reference_note)
    VALUES (NEW.product_id, 'OUT', NEW.quantity, CONCAT('Order #', NEW.order_id));
END$$

-- 3. Low stock alert: create a restock request automatically (requested_by NULL = system)
CREATE TRIGGER trg_inventory_after_update
AFTER UPDATE ON inventory
FOR EACH ROW
BEGIN
    IF NEW.quantity_on_hand <= NEW.reorder_level
       AND OLD.quantity_on_hand > OLD.reorder_level
       AND NOT EXISTS (SELECT 1 FROM restock_requests
                        WHERE product_id = NEW.product_id
                          AND status IN ('PENDING', 'APPROVED', 'ORDERED')) THEN

        INSERT INTO restock_requests (product_id, supplier_id, requested_by, quantity_requested, reason)
        SELECT NEW.product_id, p.supplier_id, NULL,
               GREATEST(NEW.reorder_level * 3 - NEW.quantity_on_hand, 1),
               CONCAT('Low stock (automatic): only ', NEW.quantity_on_hand, ' left')
          FROM products p
         WHERE p.product_id = NEW.product_id;
    END IF;
END$$

-- 4. Only customers with a DELIVERED order of the product can review it
CREATE TRIGGER trg_reviews_before_insert
BEFORE INSERT ON product_reviews
FOR EACH ROW
BEGIN
    IF NOT EXISTS (SELECT 1
                     FROM orders o
                     JOIN order_items oi ON oi.order_id = o.order_id
                    WHERE o.user_id     = NEW.user_id
                      AND oi.product_id = NEW.product_id
                      AND o.status      = 'DELIVERED') THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'You can only review products from your delivered orders';
    END IF;
END$$

DELIMITER ;

-- QUICK CHECK: should list 4 triggers
SHOW TRIGGERS FROM chompcart;