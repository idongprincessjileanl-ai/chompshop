
const productsContainer = document.getElementById("products");
const statusText = document.getElementById("status");
const searchInput = document.getElementById("searchInput");
const searchButton = document.getElementById("searchButton");

async function loadProducts() {
  const query = searchInput.value.trim();

  statusText.textContent = "Loading products...";
  productsContainer.replaceChildren();

  try {
    const response = await fetch(
      "/api/search?q=" + encodeURIComponent(query)
    );

    if (!response.ok) {
      throw new Error("Backend returned an error.");
    }

    const data = await response.json();

    // Supports either an array or an object containing products.
    const products = Array.isArray(data)
      ? data
      : data.products || [];

    if (products.length === 0) {
      statusText.textContent =
        "No products found. Check your database.";
      return;
    }

    statusText.textContent = "";

    products.forEach((product) => {
      const card = document.createElement("article");
      card.className = "product-card";

      const name = document.createElement("h3");
      name.textContent =
        product.name || product.product_name || "Unnamed Product";

      const category = document.createElement("p");
      category.textContent =
        "Category: " + (product.category || "General");

      const price = document.createElement("p");
      price.className = "price";

      const amount = Number(
        product.price ?? product.unit_price
      );

      price.textContent = Number.isFinite(amount)
        ? "₱" + amount.toLocaleString("en-PH", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
          })
        : "Price unavailable";

      card.append(name, category, price);
      productsContainer.appendChild(card);
    });
  } catch (error) {
    statusText.textContent =
      "Could not load products. Check your backend and database.";
    console.error(error);
  }
}

searchButton.addEventListener("click", loadProducts);

searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    loadProducts();
  }
});

loadProducts();