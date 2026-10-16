-- Upgrade: multi-vendor, shopping carts, shipping, checkout procedure
-- Import this AFTER schema.sql (keeps your existing data)
USE skyline_market;

CREATE TABLE vendors (
  vendor_id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL UNIQUE,
  email VARCHAR(150) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE products
  ADD COLUMN vendor_id INT NULL,
  ADD COLUMN description TEXT NULL,
  ADD CONSTRAINT fk_products_vendor FOREIGN KEY (vendor_id) REFERENCES vendors(vendor_id) ON DELETE SET NULL;

CREATE TABLE carts (
  cart_id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  status ENUM('open','checked_out') NOT NULL DEFAULT 'open',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
);

CREATE TABLE cart_items (
  cart_item_id INT AUTO_INCREMENT PRIMARY KEY,
  cart_id INT NOT NULL,
  product_id INT NOT NULL,
  quantity INT NOT NULL CHECK (quantity > 0),
  UNIQUE (cart_id, product_id),
  FOREIGN KEY (cart_id) REFERENCES carts(cart_id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE
);

CREATE TABLE shipments (
  shipment_id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL UNIQUE,
  carrier VARCHAR(60) NULL,
  tracking_no VARCHAR(60) NULL,
  status ENUM('preparing','shipped','in_transit','delivered') NOT NULL DEFAULT 'preparing',
  shipped_at DATETIME NULL,
  delivered_at DATETIME NULL,
  FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
);

DELIMITER $$

-- Stamp shipping dates automatically
CREATE TRIGGER trg_shipments_before_update
BEFORE UPDATE ON shipments FOR EACH ROW
BEGIN
  IF NEW.status = 'shipped' AND OLD.status = 'preparing' THEN SET NEW.shipped_at = NOW(); END IF;
  IF NEW.status = 'delivered' AND OLD.status <> 'delivered' THEN SET NEW.delivered_at = NOW(); END IF;
END$$

-- Mark the order as shipped when its shipment ships
CREATE TRIGGER trg_shipments_after_update
AFTER UPDATE ON shipments FOR EACH ROW
BEGIN
  IF NEW.status = 'shipped' AND OLD.status <> 'shipped' THEN
    UPDATE orders SET status = 'shipped' WHERE order_id = NEW.order_id;
  END IF;
END$$

-- Checkout: cart -> order + order items + shipment, all or nothing.
-- Existing triggers check stock and deduct it.
CREATE PROCEDURE sp_checkout_cart(IN p_cart INT)
BEGIN
  DECLARE v_customer INT DEFAULT NULL;
  DECLARE v_order INT;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;
  START TRANSACTION;
  SELECT customer_id INTO v_customer FROM carts WHERE cart_id = p_cart AND status = 'open' FOR UPDATE;
  IF v_customer IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cart not found or already checked out';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cart_items WHERE cart_id = p_cart) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cart is empty';
  END IF;
  INSERT INTO orders(customer_id, status) VALUES (v_customer, 'pending');
  SET v_order = LAST_INSERT_ID();
  INSERT INTO order_items(order_id, product_id, quantity)
    SELECT v_order, product_id, quantity FROM cart_items WHERE cart_id = p_cart;
  UPDATE carts SET status = 'checked_out' WHERE cart_id = p_cart;
  INSERT INTO shipments(order_id) VALUES (v_order);
  COMMIT;
  SELECT v_order AS order_id;
END$$

DELIMITER ;

-- Seed vendors and product descriptions (descriptions power semantic search)
INSERT INTO vendors(name, email) VALUES
  ('Skyline Electronics', 'sales@skyline-electronics.example'),
  ('Home & Hearth Co.', 'hello@homehearth.example');
UPDATE products SET vendor_id = 1, description = 'Bluetooth earbuds for music, calls and workouts' WHERE sku = 'EL-001';
UPDATE products SET vendor_id = 2, description = 'Set of ceramic mugs for coffee and tea at home' WHERE sku = 'HM-001';
UPDATE products SET vendor_id = 2, description = 'Reusable cotton bag for carrying groceries and shopping' WHERE sku = 'FS-001';
