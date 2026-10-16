-- ChompCart | Group Garchomp | Files 1 + 2 combined (tables + 50 products)
DROP DATABASE IF EXISTS chompcart;
CREATE DATABASE chompcart CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE chompcart;

-- ===================== TABLES (15) =====================
CREATE TABLE roles (
    role_id      INT AUTO_INCREMENT PRIMARY KEY,
    role_name    VARCHAR(30)  NOT NULL UNIQUE,
    description  VARCHAR(255)
);

CREATE TABLE users (
    user_id        INT AUTO_INCREMENT PRIMARY KEY,
    role_id        INT          NOT NULL,
    first_name     VARCHAR(50)  NOT NULL,
    last_name      VARCHAR(50)  NOT NULL,
    email          VARCHAR(100) NOT NULL UNIQUE,
    password_hash  VARCHAR(255) NOT NULL,
    phone          VARCHAR(20),
    is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(role_id)
);

CREATE TABLE customer_addresses (
    address_id   INT AUTO_INCREMENT PRIMARY KEY,
    user_id      INT          NOT NULL,
    label        VARCHAR(30)  NOT NULL DEFAULT 'Home',
    street       VARCHAR(150) NOT NULL,
    barangay     VARCHAR(100) NOT NULL,
    city         VARCHAR(100) NOT NULL,
    province     VARCHAR(100) NOT NULL,
    postal_code  VARCHAR(10),
    is_default   BOOLEAN      NOT NULL DEFAULT FALSE,
    CONSTRAINT fk_address_user FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE categories (
    category_id    INT AUTO_INCREMENT PRIMARY KEY,
    category_name  VARCHAR(60)  NOT NULL UNIQUE,
    description    VARCHAR(255)
);

CREATE TABLE suppliers (
    supplier_id     INT AUTO_INCREMENT PRIMARY KEY,
    supplier_name   VARCHAR(100) NOT NULL UNIQUE,
    contact_person  VARCHAR(100),
    email           VARCHAR(100),
    phone           VARCHAR(20),
    city            VARCHAR(100)
);

CREATE TABLE products (
    product_id    INT AUTO_INCREMENT PRIMARY KEY,
    category_id   INT           NOT NULL,
    supplier_id   INT           NOT NULL,
    sku           VARCHAR(20)   NOT NULL UNIQUE,
    product_name  VARCHAR(150)  NOT NULL,
    description   VARCHAR(500),
    unit_price    DECIMAL(10,2) NOT NULL,
    cost_price    DECIMAL(10,2) NOT NULL,
    is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories(category_id),
    CONSTRAINT fk_products_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(supplier_id),
    CONSTRAINT chk_products_price CHECK (unit_price >= 0 AND cost_price >= 0)
);

CREATE TABLE product_specifications (
    spec_id     INT AUTO_INCREMENT PRIMARY KEY,
    product_id  INT          NOT NULL,
    spec_name   VARCHAR(60)  NOT NULL,
    spec_value  VARCHAR(150) NOT NULL,
    CONSTRAINT fk_specs_product FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE,
    CONSTRAINT uq_specs UNIQUE (product_id, spec_name)
);

CREATE TABLE inventory (
    inventory_id      INT AUTO_INCREMENT PRIMARY KEY,
    product_id        INT       NOT NULL,
    quantity_on_hand  INT       NOT NULL DEFAULT 0,
    reorder_level     INT       NOT NULL DEFAULT 10,
    last_updated      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_inventory_product UNIQUE (product_id),
    CONSTRAINT fk_inventory_product FOREIGN KEY (product_id) REFERENCES products(product_id),
    CONSTRAINT chk_inventory_qty CHECK (quantity_on_hand >= 0 AND reorder_level >= 0)
);

CREATE TABLE inventory_transactions (
    transaction_id    INT AUTO_INCREMENT PRIMARY KEY,
    product_id        INT          NOT NULL,
    transaction_type  ENUM('IN','OUT','ADJUSTMENT','RETURN') NOT NULL,
    quantity          INT          NOT NULL,
    reference_note    VARCHAR(255),
    performed_by      INT NULL,
    created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_invtx_product FOREIGN KEY (product_id)   REFERENCES products(product_id),
    CONSTRAINT fk_invtx_user    FOREIGN KEY (performed_by) REFERENCES users(user_id),
    INDEX idx_invtx_created (created_at)
);

CREATE TABLE orders (
    order_id    INT AUTO_INCREMENT PRIMARY KEY,
    user_id     INT      NOT NULL,
    address_id  INT      NOT NULL,
    order_date  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status      ENUM('PENDING','PAID','SHIPPED','DELIVERED','CANCELLED') NOT NULL DEFAULT 'PENDING',
    CONSTRAINT fk_orders_user    FOREIGN KEY (user_id)    REFERENCES users(user_id),
    CONSTRAINT fk_orders_address FOREIGN KEY (address_id) REFERENCES customer_addresses(address_id),
    INDEX idx_orders_date (order_date)
);

CREATE TABLE order_items (
    order_item_id  INT AUTO_INCREMENT PRIMARY KEY,
    order_id       INT           NOT NULL,
    product_id     INT           NOT NULL,
    quantity       INT           NOT NULL,
    unit_price     DECIMAL(10,2) NOT NULL,
    CONSTRAINT fk_items_order   FOREIGN KEY (order_id)   REFERENCES orders(order_id) ON DELETE CASCADE,
    CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products(product_id),
    CONSTRAINT uq_items UNIQUE (order_id, product_id),
    CONSTRAINT chk_items_qty CHECK (quantity > 0)
);

CREATE TABLE payments (
    payment_id      INT AUTO_INCREMENT PRIMARY KEY,
    order_id        INT           NOT NULL UNIQUE,
    payment_method  ENUM('GCASH','MAYA','CARD','COD') NOT NULL,
    amount          DECIMAL(10,2) NOT NULL,
    payment_status  ENUM('PENDING','COMPLETED','FAILED','REFUNDED') NOT NULL DEFAULT 'PENDING',
    paid_at         DATETIME NULL,
    CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES orders(order_id),
    CONSTRAINT chk_payments_amount CHECK (amount >= 0)
);

CREATE TABLE product_reviews (
    review_id   INT AUTO_INCREMENT PRIMARY KEY,
    product_id  INT      NOT NULL,
    user_id     INT      NOT NULL,
    rating      TINYINT  NOT NULL,
    comment     VARCHAR(1000),
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_reviews_product FOREIGN KEY (product_id) REFERENCES products(product_id),
    CONSTRAINT fk_reviews_user    FOREIGN KEY (user_id)    REFERENCES users(user_id),
    CONSTRAINT uq_reviews UNIQUE (product_id, user_id),
    CONSTRAINT chk_reviews_rating CHECK (rating BETWEEN 1 AND 5)
);

CREATE TABLE demand_forecasts (
    forecast_id         INT AUTO_INCREMENT PRIMARY KEY,
    product_id          INT          NOT NULL,
    forecast_start      DATE         NOT NULL,
    forecast_end        DATE         NOT NULL,
    predicted_quantity  INT          NOT NULL,
    model_name          VARCHAR(50)  NOT NULL,
    created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_forecast_product FOREIGN KEY (product_id) REFERENCES products(product_id),
    CONSTRAINT uq_forecast UNIQUE (product_id, forecast_start, model_name),
    CONSTRAINT chk_forecast_dates CHECK (forecast_end >= forecast_start),
    CONSTRAINT chk_forecast_qty CHECK (predicted_quantity >= 0)
);

CREATE TABLE restock_requests (
    restock_id          INT AUTO_INCREMENT PRIMARY KEY,
    product_id          INT          NOT NULL,
    supplier_id         INT          NOT NULL,
    requested_by        INT NULL,
    quantity_requested  INT          NOT NULL,
    status              ENUM('PENDING','APPROVED','ORDERED','RECEIVED','REJECTED') NOT NULL DEFAULT 'PENDING',
    reason              VARCHAR(255),
    created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_restock_product  FOREIGN KEY (product_id)   REFERENCES products(product_id),
    CONSTRAINT fk_restock_supplier FOREIGN KEY (supplier_id)  REFERENCES suppliers(supplier_id),
    CONSTRAINT fk_restock_user     FOREIGN KEY (requested_by) REFERENCES users(user_id),
    CONSTRAINT chk_restock_qty CHECK (quantity_requested > 0)
);

-- ===================== DATA =====================
INSERT INTO roles (role_id, role_name, description) VALUES
(1, 'Admin',           'Full access: users, products, suppliers, reports'),
(2, 'Inventory Staff', 'Manages stock, restock requests, and reviews AI forecasts'),
(3, 'Customer',        'Browses products, places orders, writes reviews');

INSERT INTO categories (category_id, category_name, description) VALUES
(1, 'Microcontrollers & Boards',   'Arduino, ESP32, ESP8266, and Raspberry Pi boards'),
(2, 'Sensors',                     'Popular sensors for school and IoT projects'),
(3, 'Modules, Displays & Motors',  'Relays, wireless modules, LCD/OLED displays, servos, motor drivers'),
(4, 'Prototyping & Tools',         'Breadboards, jumper wires, component kits, and tools'),
(5, 'Gadget Accessories',          'Chargers, cables, power banks, audio, and storage'),
(6, 'Computer Parts',              'RAM, SSD, power supply, and graphics card'),
(7, 'Computer Peripherals',        'Keyboard, mouse, headset, monitor, and webcam');

INSERT INTO suppliers (supplier_id, supplier_name, contact_person, email, phone, city) VALUES
(1, 'MakerSpace Supply PH',          'Andrea Villanueva', 'orders@makerspace.example.ph',  '0918-555-0202', 'Quezon City'),
(2, 'Pacific Components Import Co.', 'Kevin Tan',         'import@pacificcomp.example.ph', '0919-555-0303', 'Pasay City'),
(3, 'Circuit Hub Trading',           'Ramon Dela Cruz',   'sales@circuithub.example.ph',   '0917-555-0101', 'Manila'),
(4, 'Volt & Byte Distributors',      'Maricel Santos',    'hello@voltbyte.example.ph',     '0920-555-0404', 'Cebu City'),
(5, 'TechCore PC Supply',            'Joshua Reyes',      'support@techcore.example.ph',   '0921-555-0505', 'Manila');

INSERT INTO products (category_id, supplier_id, sku, product_name, description, unit_price, cost_price) VALUES
(1, 1, 'MCU-001', 'Arduino Uno R3 (CH340 Compatible)',     'Most popular beginner board, ATmega328P',                 450.00,   280.00),
(1, 1, 'MCU-002', 'Arduino Nano V3 (CH340)',               'Compact Arduino board, breadboard friendly',              280.00,   160.00),
(1, 1, 'MCU-003', 'Arduino Mega 2560 R3 (Compatible)',     '54 digital I/O pins for bigger projects',                 850.00,   550.00),
(1, 1, 'MCU-004', 'ESP32 DevKit V1 (30-pin)',              'Wi-Fi and Bluetooth board, top choice for IoT',           380.00,   230.00),
(1, 1, 'MCU-005', 'NodeMCU ESP8266 V3',                    'Low-cost Wi-Fi board for IoT projects',                   260.00,   150.00),
(1, 1, 'MCU-006', 'Raspberry Pi Pico W',                   'RP2040 board with Wi-Fi, MicroPython ready',              520.00,   370.00),
(1, 1, 'MCU-007', 'Raspberry Pi 4 Model B (4GB)',          'Single-board computer for capstone projects',            4300.00,  3600.00),
(1, 1, 'MCU-008', 'Raspberry Pi 5 (4GB)',                  'Latest Raspberry Pi, quad-core 2.4GHz',                  4950.00,  4100.00),
(2, 2, 'SEN-001', 'HC-SR04 Ultrasonic Distance Sensor',    'Measures distance from 2cm to 400cm',                      65.00,    35.00),
(2, 2, 'SEN-002', 'DHT11 Temperature & Humidity Sensor',   'Basic temperature and humidity sensor',                    85.00,    45.00),
(2, 2, 'SEN-003', 'HC-SR501 PIR Motion Sensor',            'Detects human movement',                                   75.00,    40.00),
(2, 2, 'SEN-004', 'Capacitive Soil Moisture Sensor',       'For automatic plant watering projects',                    70.00,    35.00),
(2, 2, 'SEN-005', 'IR Obstacle Avoidance Sensor',          'For line follower and obstacle robots',                    45.00,    22.00),
(2, 2, 'SEN-006', 'MQ-2 Gas and Smoke Sensor',             'Detects LPG, smoke, and flammable gas',                    95.00,    50.00),
(2, 2, 'SEN-007', 'MPU6050 Accelerometer & Gyroscope',     '6-axis motion sensor',                                    120.00,    65.00),
(3, 2, 'MOD-001', '1-Channel 5V Relay Module',             'Controls appliances from a microcontroller',               65.00,    35.00),
(3, 2, 'MOD-002', '4-Channel 5V Relay Module',             'Controls up to four appliances',                          220.00,   130.00),
(3, 2, 'MOD-003', 'HC-05 Bluetooth Module',                'Wireless control using a phone app',                      250.00,   150.00),
(3, 2, 'MOD-004', 'RC522 RFID Reader Kit',                 'RFID reader with card and key tag',                       150.00,    85.00),
(3, 2, 'MOD-005', '16x2 LCD with I2C Module',              'Character display using only 2 data pins',                180.00,   100.00),
(3, 2, 'MOD-006', '0.96-inch OLED Display I2C',            '128x64 small display for sensor readings',                160.00,    90.00),
(3, 2, 'MOD-007', 'SG90 Micro Servo Motor',                'Small servo for robotics and door locks',                  85.00,    45.00),
(3, 2, 'MOD-008', 'L298N Motor Driver',                    'Drives two DC motors for robot cars',                     160.00,    90.00),
(4, 3, 'TOL-001', '830-Point Breadboard',                  'Full-size solderless breadboard',                          95.00,    50.00),
(4, 3, 'TOL-002', 'Jumper Wires Male-to-Male (40 pcs)',    '20cm Dupont jumper wires',                                 55.00,    28.00),
(4, 3, 'TOL-003', 'Jumper Wires Male-to-Female (40 pcs)',  '20cm Dupont jumper wires',                                 55.00,    28.00),
(4, 3, 'TOL-004', 'Resistor Kit (600 pcs)',                '30 common resistor values',                               220.00,   120.00),
(4, 3, 'TOL-005', '5mm LED Kit (100 pcs)',                 'Red, green, blue, yellow, and white LEDs',                150.00,    80.00),
(4, 3, 'TOL-006', 'Arduino Uno Starter Kit',               'Uno, breadboard, sensors, LEDs, resistors, and wires',   1450.00,   950.00),
(4, 3, 'TOL-007', 'Digital Multimeter',                    'Measures voltage, current, and resistance',               250.00,   150.00),
(4, 3, 'TOL-008', 'Adjustable Soldering Iron 60W',         'Temperature-adjustable soldering iron with tips',         380.00,   230.00),
(5, 4, 'GAD-001', 'USB-C Fast Charger 20W',                'Fast wall charger for phones and tablets',                380.00,   220.00),
(5, 4, 'GAD-002', 'USB-C to USB-C Cable 1m',               'Fast charging and data cable',                            180.00,    95.00),
(5, 4, 'GAD-003', 'Power Bank 10000mAh',                   'Portable charger with USB-C and USB-A',                   750.00,   480.00),
(5, 4, 'GAD-004', 'Wireless Earbuds Bluetooth 5.3',        'True wireless earbuds with charging case',                890.00,   560.00),
(5, 4, 'GAD-005', 'Portable Bluetooth Speaker',            'Compact speaker with 10-hour battery',                    990.00,   620.00),
(5, 4, 'GAD-006', 'MicroSD Card 64GB',                     'For phones, cameras, and Raspberry Pi',                   450.00,   290.00),
(5, 4, 'GAD-007', 'USB Flash Drive 64GB',                  'USB 3.0 flash drive for files and reports',               380.00,   230.00),
(6, 5, 'PCP-001', '8GB DDR4 3200MHz Desktop RAM',          'Memory upgrade for desktop PCs',                         1350.00,  1050.00),
(6, 5, 'PCP-002', '16GB DDR4 3200MHz Desktop RAM',         'Memory upgrade for gaming and multitasking',             2450.00,  1950.00),
(6, 5, 'PCP-003', '512GB NVMe M.2 SSD',                    'Fast storage for Windows and apps',                      2200.00,  1700.00),
(6, 5, 'PCP-004', '1TB NVMe M.2 SSD',                      'Fast storage with more space for games',                 3600.00,  2900.00),
(6, 5, 'PCP-005', '650W 80+ Bronze Power Supply',          'Reliable PSU for gaming builds',                         2900.00,  2200.00),
(6, 5, 'PCP-006', '8GB Graphics Card (Entry Gaming)',      'GDDR6 graphics card for 1080p gaming',                  16500.00, 14000.00),
(7, 5, 'PER-001', 'Wireless Mouse',                        'Silent-click 2.4GHz wireless mouse',                      350.00,   200.00),
(7, 5, 'PER-002', 'RGB Gaming Mouse',                      'Adjustable DPI wired gaming mouse',                       650.00,   400.00),
(7, 5, 'PER-003', 'Mechanical Keyboard (Blue Switch)',     'Tenkeyless keyboard with backlight',                     1450.00,   980.00),
(7, 5, 'PER-004', 'Gaming Headset with Mic',               'Over-ear headset for gaming and online classes',         1200.00,   780.00),
(7, 5, 'PER-005', '24-inch IPS Monitor 165Hz',             'Full HD monitor for gaming and work',                    6500.00,  5200.00),
(7, 5, 'PER-006', '1080p Webcam with Mic',                 'For online classes and video calls',                      900.00,   560.00);

INSERT INTO product_specifications (product_id, spec_name, spec_value)
SELECT p.product_id, s.spec_name, s.spec_value
FROM products p
JOIN (
          SELECT 'MCU-001' AS sku, 'Microcontroller' AS spec_name, 'ATmega328P' AS spec_value
    UNION ALL SELECT 'MCU-001', 'Operating Voltage', '5V'
    UNION ALL SELECT 'MCU-001', 'Digital I/O Pins', '14 (6 PWM)'
    UNION ALL SELECT 'MCU-001', 'Clock Speed', '16 MHz'
    UNION ALL SELECT 'MCU-004', 'Chip', 'ESP32-WROOM-32'
    UNION ALL SELECT 'MCU-004', 'Operating Voltage', '3.3V'
    UNION ALL SELECT 'MCU-004', 'Wireless', 'Wi-Fi 802.11 b/g/n, Bluetooth 4.2 + BLE'
    UNION ALL SELECT 'MCU-005', 'Chip', 'ESP8266'
    UNION ALL SELECT 'MCU-005', 'Wireless', 'Wi-Fi 802.11 b/g/n'
    UNION ALL SELECT 'MCU-008', 'Processor', 'Quad-core Cortex-A76 2.4 GHz'
    UNION ALL SELECT 'MCU-008', 'RAM', '4GB LPDDR4X'
    UNION ALL SELECT 'SEN-001', 'Range', '2cm to 400cm'
    UNION ALL SELECT 'SEN-002', 'Temperature Range', '0 to 50 C'
    UNION ALL SELECT 'SEN-002', 'Humidity Range', '20% to 90% RH'
    UNION ALL SELECT 'MOD-005', 'Interface', 'I2C'
    UNION ALL SELECT 'MOD-007', 'Torque', '1.8 kg-cm'
    UNION ALL SELECT 'GAD-003', 'Capacity', '10000 mAh'
    UNION ALL SELECT 'PCP-001', 'Capacity', '8GB'
    UNION ALL SELECT 'PCP-001', 'Speed', '3200 MHz'
    UNION ALL SELECT 'PCP-003', 'Capacity', '512GB'
    UNION ALL SELECT 'PCP-003', 'Interface', 'PCIe NVMe M.2 2280'
    UNION ALL SELECT 'PER-005', 'Resolution', '1920x1080'
    UNION ALL SELECT 'PER-005', 'Refresh Rate', '165Hz'
) AS s ON s.sku = p.sku;

INSERT INTO inventory (product_id, quantity_on_hand, reorder_level)
SELECT product_id,
       CASE WHEN unit_price < 100  THEN 150
            WHEN unit_price < 500  THEN 60
            WHEN unit_price < 2000 THEN 25
            WHEN unit_price < 5000 THEN 12
            ELSE 5 END,
       CASE WHEN unit_price < 100  THEN 30
            WHEN unit_price < 500  THEN 15
            WHEN unit_price < 2000 THEN 8
            WHEN unit_price < 5000 THEN 4
            ELSE 2 END
FROM products;

-- ===================== CHECK =====================
SELECT 'tables' AS item, COUNT(*) AS total FROM information_schema.tables WHERE table_schema = 'chompcart'
UNION ALL SELECT 'products',  COUNT(*) FROM products
UNION ALL SELECT 'inventory', COUNT(*) FROM inventory;