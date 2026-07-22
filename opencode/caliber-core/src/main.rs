//! caliber-core as a standalone service binary.

#[tokio::main]
async fn main() {
    caliber_core::serve().await;
}
