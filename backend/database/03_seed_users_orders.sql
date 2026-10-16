-- ChompCart | Group Garchomp | File 3: sample users and ~1 year of orders
-- Run AFTER the tables + products script.
USE chompcart;

-- Helper table: popular products appear more times, so they get picked more often
DROP TABLE IF EXISTS seed_pick;
CREATE TABLE seed_pick (seg CHAR(1), product_id INT);
INSERT INTO seed_pick (seg, product_id)
SELECT IF(p.category_id <= 4, 'E', 'G'), p.product_id
FROM products p
JOIN (SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5) w
  ON w.n <= CASE
       WHEN p.sku IN ('MCU-001','MCU-004','SEN-001','TOL-001','TOL-002','GAD-002','PER-001') THEN 5
       WHEN p.sku IN ('MCU-005','SEN-002','MOD-001','MOD-005','MOD-007','GAD-001','GAD-003',
                      'GAD-004','GAD-006','GAD-007','PER-002') THEN 3
       WHEN p.sku IN ('MCU-003','MCU-007','MCU-008','PCP-005','PCP-006','PER-005') THEN 1
       ELSE 2 END;

DROP PROCEDURE IF EXISTS sp_seed_sample_data;
DELIMITER $$
CREATE PROCEDURE sp_seed_sample_data()
BEGIN
    DECLARE i INT DEFAULT 1;
    DECLARE d DATE DEFAULT '2025-10-01';
    DECLARE e_f, g_f DECIMAL(6,3);
    DECLARE n_e, n_g, k, j, n_items, v_uid, v_oid, v_pid, v_is_board, v_bb, v_jw, v_age INT;
    DECLARE v_seg CHAR(1);
    DECLARE v_status VARCHAR(10);
    DECLARE pw VARCHAR(100) DEFAULT '$2b$10$REPLACE.WITH.REAL.BCRYPT.HASH.FROM.BACKEND.TEAM.0000000';

    START TRANSACTION;

    -- Admin and 2 Inventory Staff
    INSERT INTO users (user_id, role_id, first_name, last_name, email, password_hash, phone, created_at) VALUES
    (1, 1, 'Admin',  'Garchomp',  'admin@chompcart.example',  pw, '0917-000-0001', '2025-09-01 09:00:00'),
    (2, 2, 'Stella', 'Inventory', 'staff1@chompcart.example', pw, '0917-000-0002', '2025-09-01 09:05:00'),
    (3, 2, 'Nathan', 'Inventory', 'staff2@chompcart.example', pw, '0917-000-0003', '2025-09-01 09:10:00');

    -- 60 customers, each with one default address (user_id 4 to 63, address_id 1 to 60)
    WHILE i <= 60 DO
        INSERT INTO users (user_id, role_id, first_name, last_name, email, password_hash, phone, created_at)
        VALUES (i + 3, 3,
            ELT(1 + MOD(i - 1, 20), 'Juan','Maria','Jose','Ana','Mark','Angelica','John','Kristine','Paolo','Camille',
                'Miguel','Patricia','Carlo','Nicole','Rafael','Bea','Joshua','Andrea','Kevin','Trisha'),
            ELT(1 + MOD(i * 7 + FLOOR((i - 1) / 20), 20), 'Dela Cruz','Santos','Reyes','Garcia','Mendoza','Torres','Ramos',
                'Flores','Gonzales','Bautista','Villanueva','Aquino','Castillo','Navarro','Fernandez','Rivera',
                'Domingo','Mercado','Lopez','Cruz'),
            CONCAT('customer', i, '@example.com'), pw,
            CONCAT('09', 15 + MOD(i * 13, 80), '-', 100 + MOD(i * 37, 900), '-', 1000 + MOD(i * 731, 9000)),
            TIMESTAMP('2025-09-01') + INTERVAL i * 11 HOUR);

        INSERT INTO customer_addresses (address_id, user_id, label, street, barangay, city, province, postal_code, is_default)
        VALUES (i, i + 3,
            ELT(1 + MOD(i, 4), 'Home', 'Home', 'Dorm', 'School'),
            CONCAT('Blk ', 1 + MOD(i * 3, 40), ' Lot ', 1 + MOD(i * 7, 30), ' Rizal St.'),
            ELT(1 + MOD(i * 3, 6), 'San Roque', 'Concepcion Uno', 'Malanday', 'Santolan', 'Poblacion', 'Santo Nino'),
            ELT(1 + MOD(i, 6), 'Marikina', 'Quezon City', 'Manila', 'Pasig', 'Taguig', 'Antipolo'),
            IF(MOD(i, 6) = 5, 'Rizal', 'Metro Manila'),
            ELT(1 + MOD(i, 6), '1800', '1100', '1000', '1600', '1630', '1870'),
            TRUE);
        SET i = i + 1;
    END WHILE;

    SELECT product_id INTO v_bb FROM products WHERE sku = 'TOL-001';  -- breadboard
    SELECT product_id INTO v_jw FROM products WHERE sku = 'TOL-002';  -- jumper wires

    -- One day at a time, from Oct 1, 2025 to today
    WHILE d <= CURDATE() DO
        -- Electronics: high at semester start (Aug, Jan) and capstone season (Mar), low in summer and December
        SET e_f = ELT(MONTH(d), 1.7, 1.3, 1.6, 1.3, 0.6, 0.5, 0.8, 1.9, 1.4, 1.2, 1.0, 0.6);
        -- Gadgets and PC parts: high on 9.9, 11.11, 12.12, and Christmas
        SET g_f = ELT(MONTH(d), 0.9, 1.0, 0.9, 0.9, 1.0, 1.0, 0.9, 1.0, 1.2, 1.0, 1.6, 1.9);
        IF MONTH(d) = DAY(d) AND MONTH(d) >= 9 THEN SET g_f = g_f * 3; SET e_f = e_f * 1.3; END IF;
        IF DAY(d) IN (15, 30) THEN SET e_f = e_f * 1.25; SET g_f = g_f * 1.35; END IF;   -- payday
        IF DAYOFWEEK(d) IN (1, 7) THEN SET e_f = e_f * 1.1; SET g_f = g_f * 1.2; END IF; -- weekend

        SET n_e = ROUND(4.2 * e_f * (0.6 + RAND() * 0.8));
        SET n_g = ROUND(2.4 * g_f * (0.6 + RAND() * 0.8));
        SET v_age = DATEDIFF(CURDATE(), d);
        SET k = 1;

        WHILE k <= n_e + n_g DO
            SET v_seg = IF(k <= n_e, 'E', 'G');
            SET v_uid = 4 + FLOOR(RAND() * 60);
            SET v_status = CASE
                WHEN v_age > 10 THEN IF(RAND() < 0.04, 'CANCELLED', 'DELIVERED')
                WHEN v_age > 5  THEN IF(RAND() < 0.70, 'DELIVERED', 'SHIPPED')
                WHEN v_age > 2  THEN IF(RAND() < 0.60, 'SHIPPED', 'PAID')
                ELSE IF(RAND() < 0.50, 'PAID', 'PENDING') END;

            INSERT INTO orders (user_id, address_id, order_date, status)
            VALUES (v_uid, v_uid - 3,
                    LEAST(TIMESTAMP(d, SEC_TO_TIME(FLOOR(28800 + RAND() * 54000))), NOW()),
                    v_status);
            SET v_oid = LAST_INSERT_ID();

            SET n_items = 1 + FLOOR(RAND() * RAND() * 3.5);
            SET j = 1;
            WHILE j <= n_items DO
                SELECT product_id INTO v_pid FROM seed_pick WHERE seg = v_seg ORDER BY RAND() LIMIT 1;

                INSERT IGNORE INTO order_items (order_id, product_id, quantity, unit_price)
                SELECT v_oid, p.product_id,
                       CASE WHEN p.unit_price < 120 THEN 1 + FLOOR(RAND() * 4)
                            WHEN p.unit_price < 600 THEN 1 + (RAND() < 0.25)
                            ELSE 1 END,
                       p.unit_price
                FROM products p WHERE p.product_id = v_pid;

                -- Frequently bought together: boards come with a breadboard and jumper wires
                SELECT COUNT(*) INTO v_is_board FROM products
                 WHERE product_id = v_pid AND sku IN ('MCU-001','MCU-002','MCU-003','MCU-004','MCU-005');
                IF v_is_board = 1 THEN
                    IF RAND() < 0.55 THEN
                        INSERT IGNORE INTO order_items (order_id, product_id, quantity, unit_price)
                        SELECT v_oid, product_id, 1, unit_price FROM products WHERE product_id = v_bb;
                    END IF;
                    IF RAND() < 0.45 THEN
                        INSERT IGNORE INTO order_items (order_id, product_id, quantity, unit_price)
                        SELECT v_oid, product_id, 1 + (RAND() < 0.3), unit_price FROM products WHERE product_id = v_jw;
                    END IF;
                END IF;
                SET j = j + 1;
            END WHILE;
            SET k = k + 1;
        END WHILE;
        SET d = DATE_ADD(d, INTERVAL 1 DAY);
    END WHILE;

    -- One payment per order
    INSERT INTO payments (order_id, payment_method, amount, payment_status, paid_at)
    SELECT o.order_id, x.method, t.total,
           CASE WHEN o.status = 'CANCELLED' THEN IF(x.method = 'COD', 'FAILED', 'REFUNDED')
                WHEN o.status = 'PENDING' THEN 'PENDING'
                WHEN x.method = 'COD' AND o.status <> 'DELIVERED' THEN 'PENDING'
                ELSE 'COMPLETED' END,
           CASE WHEN o.status = 'PENDING' THEN NULL
                WHEN x.method = 'COD' THEN IF(o.status = 'DELIVERED', o.order_date + INTERVAL 3 DAY, NULL)
                ELSE o.order_date + INTERVAL 10 MINUTE END
    FROM orders o
    JOIN (SELECT order_id, SUM(quantity * unit_price) AS total FROM order_items GROUP BY order_id) t
      ON t.order_id = o.order_id
    JOIN (SELECT order_id,
                 CASE WHEN MOD(order_id, 20) < 9  THEN 'GCASH'
                      WHEN MOD(order_id, 20) < 12 THEN 'MAYA'
                      WHEN MOD(order_id, 20) < 15 THEN 'CARD'
                      ELSE 'COD' END AS method
          FROM orders) x
      ON x.order_id = o.order_id;

    -- Reviews from customers with delivered orders (one per customer per product)
    INSERT IGNORE INTO product_reviews (product_id, user_id, rating, comment, created_at)
    SELECT r.product_id, r.user_id, r.rating,
           ELT(r.rating, 'Did not work out of the box.', 'Arrived late, needed replacement.',
               'Okay lang, does the job.', 'Good product, works well.', 'Legit and fast delivery, sulit!'),
           r.order_date + INTERVAL 7 DAY
    FROM (SELECT oi.product_id, o.user_id, o.order_date,
                 CASE WHEN MOD(o.order_id + oi.product_id, 20) < 11 THEN 5
                      WHEN MOD(o.order_id + oi.product_id, 20) < 17 THEN 4
                      WHEN MOD(o.order_id + oi.product_id, 20) < 19 THEN 3
                      ELSE 2 END AS rating
          FROM orders o
          JOIN order_items oi ON oi.order_id = o.order_id
          WHERE o.status = 'DELIVERED'
            AND o.order_date < NOW() - INTERVAL 7 DAY
            AND RAND() < 0.18) r;

    -- Past restock requests (already finished)
    INSERT INTO restock_requests (product_id, supplier_id, requested_by, quantity_requested, status, reason, created_at)
    SELECT product_id, supplier_id, 2,
           IF(unit_price < 500, 50, 10),
           IF(MOD(product_id, 5) = 0, 'REJECTED', 'RECEIVED'),
           'Restock before semester start',
           '2026-07-20 10:00:00'
    FROM products
    WHERE sku IN ('MCU-001','MCU-004','SEN-001','SEN-002','TOL-001','TOL-002','TOL-003',
                  'MOD-001','MOD-005','MOD-007','GAD-001','GAD-002','PER-001','PCP-003');

    COMMIT;
END$$
DELIMITER ;

CALL sp_seed_sample_data();

-- Clean up the helpers (they are not part of the final database)
DROP PROCEDURE IF EXISTS sp_seed_sample_data;
DROP TABLE IF EXISTS seed_pick;

-- QUICK CHECK
SELECT 'users' AS table_name, COUNT(*) AS total FROM users
UNION ALL SELECT 'customer_addresses', COUNT(*) FROM customer_addresses
UNION ALL SELECT 'orders', COUNT(*) FROM orders
UNION ALL SELECT 'order_items', COUNT(*) FROM order_items
UNION ALL SELECT 'payments', COUNT(*) FROM payments
UNION ALL SELECT 'product_reviews', COUNT(*) FROM product_reviews
UNION ALL SELECT 'restock_requests', COUNT(*) FROM restock_requests
UNION ALL SELECT 'tables (should be 15)', COUNT(*) FROM information_schema.tables WHERE table_schema = 'chompcart';