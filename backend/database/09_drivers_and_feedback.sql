-- ChompCart | Group Garchomp | File 9: delivery riders, proof of delivery, rider ratings
-- Run AFTER File 8 (before File 7). If you re-run File 1, run Files 3 to 9 again.
USE chompcart;

DROP TRIGGER IF EXISTS trg_driver_ratings_before_insert;
DROP VIEW IF EXISTS vw_driver_performance;
DROP TABLE IF EXISTS driver_ratings;
DROP TABLE IF EXISTS deliveries;
DROP TABLE IF EXISTS drivers;

-- ===================== TABLES (3 new, 18 total) =====================

-- Delivery riders. service_area lists the cities each rider covers.
CREATE TABLE drivers (
    driver_id     INT AUTO_INCREMENT PRIMARY KEY,
    full_name     VARCHAR(100) NOT NULL,
    phone         VARCHAR(20)  NOT NULL,
    vehicle       VARCHAR(50)  NOT NULL,
    plate_no      VARCHAR(15)  NOT NULL UNIQUE,
    service_area  VARCHAR(150) NOT NULL,
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One delivery per order: which rider took it and the proof that it arrived
CREATE TABLE deliveries (
    delivery_id      INT AUTO_INCREMENT PRIMARY KEY,
    order_id         INT          NOT NULL UNIQUE,
    driver_id        INT          NOT NULL,
    assigned_by      INT NULL,
    assigned_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    delivered_at     DATETIME NULL,
    recipient_name   VARCHAR(100) NULL,
    proof_image_url  VARCHAR(255) NULL,
    notes            VARCHAR(255) NULL,
    CONSTRAINT fk_deliveries_order  FOREIGN KEY (order_id)    REFERENCES orders(order_id),
    CONSTRAINT fk_deliveries_driver FOREIGN KEY (driver_id)   REFERENCES drivers(driver_id),
    CONSTRAINT fk_deliveries_staff  FOREIGN KEY (assigned_by) REFERENCES users(user_id),
    CONSTRAINT chk_deliveries_dates CHECK (delivered_at IS NULL OR delivered_at >= assigned_at)
);

-- Customer feedback about the rider (one per order)
CREATE TABLE driver_ratings (
    rating_id   INT AUTO_INCREMENT PRIMARY KEY,
    order_id    INT      NOT NULL UNIQUE,
    driver_id   INT      NOT NULL,
    user_id     INT      NOT NULL,
    rating      TINYINT  NOT NULL,
    comment     VARCHAR(500),
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_dratings_order  FOREIGN KEY (order_id)  REFERENCES orders(order_id),
    CONSTRAINT fk_dratings_driver FOREIGN KEY (driver_id) REFERENCES drivers(driver_id),
    CONSTRAINT fk_dratings_user   FOREIGN KEY (user_id)   REFERENCES users(user_id),
    CONSTRAINT chk_dratings_rating CHECK (rating BETWEEN 1 AND 5)
);

-- ===================== DATA =====================

INSERT INTO drivers (driver_id, full_name, phone, vehicle, plate_no, service_area, created_at) VALUES
(1, 'Ramon Bautista',  '0917-555-1101', 'Motorcycle', 'NAB 1101', 'Quezon City',        '2025-09-01 08:00:00'),
(2, 'Liza Fernandez',  '0917-555-1102', 'Motorcycle', 'NAB 1102', 'Manila',             '2025-09-01 08:00:00'),
(3, 'Jerome Castillo', '0917-555-1103', 'Motorcycle', 'NAB 1103', 'Marikina, Antipolo', '2025-09-01 08:00:00'),
(4, 'Arnel Domingo',   '0917-555-1104', 'Motorcycle', 'NAB 1104', 'Pasig',              '2025-09-01 08:00:00'),
(5, 'Kevin Mercado',   '0917-555-1105', 'Delivery Van','NAB 1105', 'Taguig',             '2025-09-01 08:00:00');

-- Past deliveries for the sample orders: the rider who covers the customer's city
INSERT INTO deliveries (order_id, driver_id, assigned_by, assigned_at, delivered_at, recipient_name)
SELECT o.order_id, d.driver_id, 2,
       LEAST(o.order_date + INTERVAL 1 DAY, NOW()),
       CASE WHEN o.status = 'DELIVERED'
            THEN LEAST(o.order_date + INTERVAL (2 + MOD(o.order_id, 3)) DAY, NOW()) END,
       CASE WHEN o.status = 'DELIVERED' THEN CONCAT(u.first_name, ' ', u.last_name) END
FROM orders o
JOIN users u              ON u.user_id    = o.user_id
JOIN customer_addresses a ON a.address_id = o.address_id
JOIN drivers d            ON d.service_area LIKE CONCAT('%', a.city, '%')
WHERE o.status IN ('SHIPPED', 'DELIVERED');

-- Sample rider ratings for about a quarter of the delivered orders
INSERT INTO driver_ratings (order_id, driver_id, user_id, rating, comment, created_at)
SELECT o.order_id, dl.driver_id, o.user_id, r.rating,
       ELT(r.rating, 'Rider was hard to contact.', 'Late delivery.', 'Okay naman.',
           'Mabilis at maayos.', 'Very polite rider, ingat palagi!'),
       LEAST(dl.delivered_at + INTERVAL 1 HOUR, NOW())
FROM orders o
JOIN deliveries dl ON dl.order_id = o.order_id
JOIN (SELECT order_id,
             CASE WHEN MOD(order_id, 10) < 6 THEN 5
                  WHEN MOD(order_id, 10) < 9 THEN 4
                  ELSE 3 END AS rating
      FROM orders) r ON r.order_id = o.order_id
WHERE o.status = 'DELIVERED' AND MOD(o.order_id, 4) = 0;

-- ===================== VIEW =====================

-- Rider scorecard for the staff portal and reports
CREATE OR REPLACE VIEW vw_driver_performance AS
SELECT
    d.driver_id, d.full_name, d.phone, d.vehicle, d.plate_no, d.service_area, d.is_active,
    COUNT(dl.delivery_id)                                       AS total_assigned,
    SUM(dl.delivery_id IS NOT NULL AND dl.delivered_at IS NULL) AS out_for_delivery,
    SUM(dl.delivered_at IS NOT NULL)                            AS delivered,
    ROUND(AVG(TIMESTAMPDIFF(HOUR, dl.assigned_at, dl.delivered_at)) / 24, 1) AS avg_days_to_deliver,
    (SELECT ROUND(AVG(rating), 1) FROM driver_ratings WHERE driver_id = d.driver_id) AS avg_rating,
    (SELECT COUNT(*)              FROM driver_ratings WHERE driver_id = d.driver_id) AS rating_count
FROM drivers d
LEFT JOIN deliveries dl ON dl.driver_id = d.driver_id
GROUP BY d.driver_id, d.full_name, d.phone, d.vehicle, d.plate_no, d.service_area, d.is_active;

-- ===================== TRIGGER =====================

DELIMITER $$

-- Customers can rate the rider only after the order is delivered, and only the rider who delivered it
CREATE TRIGGER trg_driver_ratings_before_insert
BEFORE INSERT ON driver_ratings
FOR EACH ROW
BEGIN
    IF NOT EXISTS (SELECT 1
                     FROM orders o
                     JOIN deliveries dl ON dl.order_id = o.order_id
                    WHERE o.order_id     = NEW.order_id
                      AND o.user_id      = NEW.user_id
                      AND o.status       = 'DELIVERED'
                      AND dl.driver_id   = NEW.driver_id) THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'You can only rate the rider of your own delivered order';
    END IF;
END$$

DELIMITER ;

-- ===================== CHECK =====================
SELECT * FROM vw_driver_performance;
SELECT 'deliveries' AS table_name, COUNT(*) AS total FROM deliveries
UNION ALL SELECT 'driver_ratings', COUNT(*) FROM driver_ratings
UNION ALL SELECT 'tables (should be 18)', COUNT(*) FROM information_schema.tables
          WHERE table_schema = 'chompcart' AND table_type = 'BASE TABLE';
