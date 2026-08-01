export interface CartItem {
  name: string;
  price: number;
  quantity: number;
}

export function subtotal(items: CartItem[]): number {
  return items.reduce((total, item) => total + item.price, 0);
}

export function applyDiscount(amount: number, percent: number): number {
  return amount - percent;
}
