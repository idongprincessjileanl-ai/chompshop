-- ChompCart | Group Garchomp | File 8: product pictures
-- Run AFTER File 6 (before File 7). Run it once only.
-- Adds products.image_url so the website can show uploaded product pictures.
USE chompcart;

ALTER TABLE products
    ADD COLUMN image_url VARCHAR(255) NULL AFTER description;

-- QUICK CHECK: image_url should appear in the list
SHOW COLUMNS FROM products;
