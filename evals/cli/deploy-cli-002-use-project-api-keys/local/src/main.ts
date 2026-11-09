import { supabase } from './supabase';

const app = document.querySelector('#app');

async function render() {
  if (!app) return;
  const { data, error } = await supabase
    .from('orders')
    .select('id, customer, total');
  if (error) {
    app.textContent = `Could not load orders: ${error.message}`;
    return;
  }
  const list = document.createElement('ul');
  for (const order of data ?? []) {
    const item = document.createElement('li');
    item.textContent = `#${order.id} ${order.customer}: ${order.total}`;
    list.append(item);
  }
  app.replaceChildren(list);
}

render();
