-- ChompCart | Group Garchomp | File 4: 6 views (requirement: at least 3)
USE chompcart;

-- VIEW 1: Product catalog for the frontend (JOIN + LEFT JOIN + subquery + aggregate)
CREATE OR REPLACE VIEW vw_product_catalog AS
SELECT
    p.product_id, p.sku, p.product_name, p.description,
    c.category_name, s.supplier_name, p.unit_price, i.quantity_on_hand,
    CASE WHEN i.quantity_on_hand = 0                THEN 'Out of Stock'
         WHEN i.quantity_on_hand <= i.reorder_level THEN 'Low Stock'
         ELSE 'In Stock' END            AS stock_status,
    COALESCE(r.avg_rating, 0)           AS avg_rating,
    COALESCE(r.review_count, 0)         AS review_count
FROM products p
JOIN categories c ON c.category_id = p.category_id
JOIN suppliers  s ON s.supplier_id = p.supplier_id
JOIN inventory  i ON i.product_id  = p.product_id
LEFT JOIN (SELECT product_id, ROUND(AVG(rating), 1) AS avg_rating, COUNT(*) AS review_count
           FROM product_reviews GROUP BY product_id) r ON r.product_id = p.product_id
WHERE p.is_active = TRUE;

-- VIEW 2: Daily sales for the admin dashboard chart
CREATE OR REPLACE VIEW vw_daily_sales_summary AS
SELECT
    DATE(o.order_date)               AS sale_date,
    COUNT(DISTINCT o.order_id)       AS total_orders,
    SUM(oi.quantity)                 AS items_sold,
    SUM(oi.quantity * oi.unit_price) AS total_revenue
FROM orders o
JOIN order_items oi ON oi.order_id = o.order_id
WHERE o.status <> 'CANCELLED'
GROUP BY DATE(o.order_date);

-- VIEW 3: Monthly sales per category (seasonal trends for the AI)
CREATE OR REPLACE VIEW vw_monthly_category_sales AS
SELECT
    DATE_FORMAT(o.order_date, '%Y-%m') AS sale_month,
    c.category_id, c.category_name,
    SUM(oi.quantity)                   AS units_sold,
    SUM(oi.quantity * oi.unit_price)   AS revenue
FROM orders o
JOIN order_items oi ON oi.order_id   = o.order_id
JOIN products    p  ON p.product_id  = oi.product_id
JOIN categories  c  ON c.category_id = p.category_id
WHERE o.status <> 'CANCELLED'
GROUP BY DATE_FORMAT(o.order_date, '%Y-%m'), c.category_id, c.category_name;

-- VIEW 4: Best sellers with ranking
CREATE OR REPLACE VIEW vw_top_selling_products AS
SELECT
    p.product_id, p.sku, p.product_name, c.category_name,
    SUM(oi.quantity)                             AS total_units_sold,
    SUM(oi.quantity * oi.unit_price)             AS total_revenue,
    RANK() OVER (ORDER BY SUM(oi.quantity) DESC) AS sales_rank
FROM order_items oi
JOIN orders     o ON o.order_id    = oi.order_id
JOIN products   p ON p.product_id  = oi.product_id
JOIN categories c ON c.category_id = p.category_id
WHERE o.status <> 'CANCELLED'
GROUP BY p.product_id, p.sku, p.product_name, c.category_name;

-- VIEW 5: Low stock list for Inventory Staff
CREATE OR REPLACE VIEW vw_low_stock_products AS
SELECT
    p.product_id, p.sku, p.product_name, c.category_name,
    i.quantity_on_hand, i.reorder_level,
    s.supplier_name, s.phone AS supplier_phone,
    EXISTS (SELECT 1 FROM restock_requests r
            WHERE r.product_id = p.product_id
              AND r.status IN ('PENDING', 'APPROVED', 'ORDERED')) AS has_open_restock_request
FROM inventory i
JOIN products   p ON p.product_id  = i.product_id
JOIN categories c ON c.category_id = p.category_id
JOIN suppliers  s ON s.supplier_id = p.supplier_id
WHERE i.quantity_on_hand <= i.reorder_level;

-- VIEW 6: AI predictions vs actual sales
CREATE OR REPLACE VIEW vw_forecast_vs_actual AS
SELECT
    f.forecast_id, p.sku, p.product_name, f.model_name,
    f.forecast_start, f.forecast_end, f.predicted_quantity,
    COALESCE((SELECT SUM(oi.quantity)
              FROM order_items oi
              JOIN orders o ON o.order_id = oi.order_id
              WHERE oi.product_id = f.product_id
                AND o.status <> 'CANCELLED'
                AND DATE(o.order_date) BETWEEN f.forecast_start AND f.forecast_end), 0) AS actual_quantity,
    CASE WHEN f.forecast_end < CURDATE() THEN 'Completed' ELSE 'In Progress' END AS period_status
FROM demand_forecasts f
JOIN products p ON p.product_id = f.product_id;

-- QUICK CHECK: should list 6 views
SHOW FULL TABLES WHERE Table_type = 'VIEW';