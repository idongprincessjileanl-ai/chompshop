#!/bin/bash
# Runs once, the first time the MySQL container starts with an empty volume.
# Loads the ChompCart SQL files in order (07 is the demo script, so it is skipped).
set -e
for f in 01_02_tables_and_products 03_seed_users_orders 04_views 05_stored_procedures \
         06_triggers 08_product_images 09_drivers_and_feedback 10_security_rls 11_saved_cart_and_ai_fraud; do
  echo ">>> Loading $f.sql"
  mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --default-character-set=utf8mb4 < "/sql/$f.sql" > /dev/null
done
echo ">>> ChompCart database is ready"
