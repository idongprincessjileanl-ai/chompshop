-- ChompCart | Group Garchomp | File 7: test queries and live demo
-- NOTE: Part E adds new orders. To reset, run Files 1 to 6 again.
USE chompcart;

-- ========== PART A: MULTI-TABLE JOINS ==========
-- A1. Full order details (7 tables)
SELECT o.order_id, o.order_date, CONCAT(u.first_name, ' ', u.last_name) AS customer, a.city,
       p.product_name, c.category_name, oi.quantity, oi.unit_price,
       oi.quantity * oi.unit_price AS line_total, pay.payment_method, o.status
FROM orders o
JOIN users              u   ON u.user_id     = o.user_id
JOIN customer_addresses a   ON a.address_id  = o.address_id
JOIN order_items        oi  ON oi.order_id   = o.order_id
JOIN products           p   ON p.product_id  = oi.product_id
JOIN categories         c   ON c.category_id = p.category_id
JOIN payments           pay ON pay.order_id  = o.order_id
ORDER BY o.order_date DESC
LIMIT 20;

-- A2. Reviews with customer and product names
SELECT p.product_name, CONCAT(u.first_name, ' ', u.last_name) AS reviewer, r.rating, r.comment
FROM product_reviews r
JOIN products p ON p.product_id = r.product_id
JOIN users    u ON u.user_id    = r.user_id
ORDER BY r.created_at DESC
LIMIT 15;

-- ========== PART B: SUBQUERIES ==========
-- B1. Customers who spent more than the average customer
SELECT u.user_id, CONCAT(u.first_name, ' ', u.last_name) AS customer, SUM(pay.amount) AS total_spent
FROM users u
JOIN orders   o   ON o.user_id    = u.user_id
JOIN payments pay ON pay.order_id = o.order_id
WHERE pay.payment_status = 'COMPLETED'
GROUP BY u.user_id, u.first_name, u.last_name
HAVING SUM(pay.amount) > (
    SELECT AVG(customer_total) FROM (
        SELECT SUM(pay2.amount) AS customer_total
        FROM orders o2 JOIN payments pay2 ON pay2.order_id = o2.order_id
        WHERE pay2.payment_status = 'COMPLETED'
        GROUP BY o2.user_id) AS totals)
ORDER BY total_spent DESC;

-- B2. Products priced above the average of their own category (correlated subquery)
SELECT p.sku, p.product_name, c.category_name, p.unit_price
FROM products p
JOIN categories c ON c.category_id = p.category_id
WHERE p.unit_price > (SELECT AVG(p2.unit_price) FROM products p2 WHERE p2.category_id = p.category_id)
ORDER BY c.category_name, p.unit_price DESC;

-- B3. "Frequently bought together" with Arduino Uno (for AI recommendations)
SELECT p.sku, p.product_name, COUNT(*) AS times_bought_together
FROM order_items oi
JOIN products p ON p.product_id = oi.product_id
WHERE oi.order_id IN (SELECT oi2.order_id FROM order_items oi2
                      JOIN products p2 ON p2.product_id = oi2.product_id
                      WHERE p2.sku = 'MCU-001')
  AND p.sku <> 'MCU-001'
GROUP BY p.sku, p.product_name
ORDER BY times_bought_together DESC
LIMIT 5;

-- ========== PART C: AGGREGATE FUNCTIONS ==========
-- C1. Revenue per category
SELECT c.category_name, COUNT(DISTINCT oi.order_id) AS orders, SUM(oi.quantity) AS units_sold,
       SUM(oi.quantity * oi.unit_price) AS revenue, ROUND(AVG(oi.unit_price), 2) AS avg_item_price
FROM order_items oi
JOIN orders     o ON o.order_id    = oi.order_id
JOIN products   p ON p.product_id  = oi.product_id
JOIN categories c ON c.category_id = p.category_id
WHERE o.status <> 'CANCELLED'
GROUP BY c.category_name
ORDER BY revenue DESC;

-- C2. Monthly sales (shows the seasonal pattern)
SELECT DATE_FORMAT(o.order_date, '%Y-%m') AS sale_month, COUNT(DISTINCT o.order_id) AS orders,
       SUM(oi.quantity) AS units_sold, SUM(oi.quantity * oi.unit_price) AS revenue
FROM orders o
JOIN order_items oi ON oi.order_id = o.order_id
WHERE o.status <> 'CANCELLED'
GROUP BY sale_month
ORDER BY sale_month;

-- C3. Payment method share
SELECT payment_method, COUNT(*) AS payments,
       ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM payments), 1) AS percent,
       SUM(amount) AS total_amount
FROM payments
GROUP BY payment_method
ORDER BY payments DESC;

-- ========== PART D: VIEWS ==========
SELECT * FROM vw_product_catalog ORDER BY category_name, product_name;
SELECT * FROM vw_top_selling_products WHERE sales_rank <= 10;
SELECT * FROM vw_monthly_category_sales ORDER BY sale_month, category_id;

-- ========== PART E: PROCEDURES AND TRIGGERS IN ACTION ==========
-- E1. Sales history for the AI model (Arduino Uno, last 52 weeks)
SET @uno := (SELECT product_id FROM products WHERE sku = 'MCU-001');
CALL sp_get_sales_history(@uno, 52);

-- E2. Customer 4 buys 1 Arduino Uno + 2 breadboards
SET @customer := 4;
SET @addr     := (SELECT address_id FROM customer_addresses WHERE user_id = @customer AND is_default = TRUE LIMIT 1);
SET @board    := (SELECT product_id FROM products WHERE sku = 'TOL-001');
SELECT product_id, quantity_on_hand AS stock_before FROM inventory WHERE product_id IN (@uno, @board);
CALL sp_place_order(@customer, @addr,
     CONCAT('[{"product_id": ', @uno, ', "quantity": 1}, {"product_id": ', @board, ', "quantity": 2}]'),
     'GCASH', @new_order);
SELECT product_id, quantity_on_hand AS stock_after FROM inventory WHERE product_id IN (@uno, @board);
SELECT * FROM inventory_transactions ORDER BY transaction_id DESC LIMIT 5;

-- E3. Staff moves the order: PAID -> SHIPPED -> DELIVERED
CALL sp_update_order_status(@new_order, 'PAID', 2);
CALL sp_update_order_status(@new_order, 'SHIPPED', 2);
CALL sp_update_order_status(@new_order, 'DELIVERED', 2);
SELECT o.order_id, o.status, pay.payment_status, pay.amount
FROM orders o JOIN payments pay ON pay.order_id = o.order_id
WHERE o.order_id = @new_order;

-- E4. Cancel an order: stock comes back
CALL sp_place_order(@customer, @addr, CONCAT('[{"product_id": ', @uno, ', "quantity": 2}]'), 'COD', @cancel_order);
CALL sp_update_order_status(@cancel_order, 'CANCELLED', 2);
SELECT * FROM inventory_transactions ORDER BY transaction_id DESC LIMIT 3;

-- E5. Low-stock trigger: buying 8 Raspberry Pi 5 drops stock to the reorder level
SET @pi5 := (SELECT product_id FROM products WHERE sku = 'MCU-008');
SELECT quantity_on_hand, reorder_level FROM inventory WHERE product_id = @pi5;
CALL sp_place_order(@customer, @addr, CONCAT('[{"product_id": ', @pi5, ', "quantity": 8}]'), 'CARD', @big_order);
SELECT * FROM restock_requests WHERE product_id = @pi5 ORDER BY restock_id DESC LIMIT 1;
SELECT * FROM vw_low_stock_products;

-- E6. Staff receives the restock: stock goes back up
SET @rid := (SELECT MAX(restock_id) FROM restock_requests WHERE product_id = @pi5);
CALL sp_receive_restock(@rid, 2);
SELECT quantity_on_hand AS pi5_stock_after_restock FROM inventory WHERE product_id = @pi5;

-- E7. AI forecast -> restock suggestion (sample value; the AI module normally saves this)
CALL sp_save_forecast(@uno, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 6 DAY), 80, 'Demo');
CALL sp_generate_restock_suggestions(2);
SELECT * FROM vw_forecast_vs_actual;