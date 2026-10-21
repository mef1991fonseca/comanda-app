// Tipos del esquema, derivados de Supabase (generate_typescript_types).
// Actualizar después de cada migración: `npx supabase gen types typescript --project-id mosfrmkbutyqqckjnkkd`.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

type Ts = string

export type Database = {
  __InternalSupabase: { PostgrestVersion: '14.18' }
  public: {
    Tables: {
      cash_movements: {
        Row: { amount: number; cash_session_id: string; created_at: Ts; created_by: string | null; id: string; kind: string; reason: string | null; restaurant_id: string }
        Insert: { amount: number; cash_session_id: string; created_at?: Ts; created_by?: string | null; id?: string; kind: string; reason?: string | null; restaurant_id: string }
        Update: Partial<Database['public']['Tables']['cash_movements']['Insert']>
        Relationships: []
      }
      cash_sessions: {
        Row: { closed_at: Ts | null; closed_by: string | null; counted_cash: number | null; created_at: Ts; expected_cash: number | null; id: string; notes: string | null; opened_at: Ts; opened_by: string | null; opening_amount: number; register_id: string; restaurant_id: string; updated_at: Ts }
        Insert: { closed_at?: Ts | null; closed_by?: string | null; counted_cash?: number | null; created_at?: Ts; expected_cash?: number | null; id?: string; notes?: string | null; opened_at?: Ts; opened_by?: string | null; opening_amount?: number; register_id: string; restaurant_id: string; updated_at?: Ts }
        Update: Partial<Database['public']['Tables']['cash_sessions']['Insert']>
        Relationships: []
      }
      categories: {
        Row: { active: boolean; created_at: Ts; id: string; name: string; parent_id: string | null; restaurant_id: string; sort_order: number; updated_at: Ts }
        Insert: { active?: boolean; created_at?: Ts; id?: string; name: string; parent_id?: string | null; restaurant_id: string; sort_order?: number; updated_at?: Ts }
        Update: Partial<Database['public']['Tables']['categories']['Insert']>
        Relationships: []
      }
      dining_areas: {
        Row: { active: boolean; created_at: Ts; id: string; name: string; restaurant_id: string; sort_order: number; updated_at: Ts }
        Insert: { active?: boolean; created_at?: Ts; id?: string; name: string; restaurant_id: string; sort_order?: number; updated_at?: Ts }
        Update: Partial<Database['public']['Tables']['dining_areas']['Insert']>
        Relationships: []
      }
      ingredients: {
        Row: { active: boolean; cost_per_unit: number; created_at: Ts; id: string; min_stock: number; name: string; restaurant_id: string; stock_qty: number; unit: Database['public']['Enums']['stock_unit']; updated_at: Ts }
        Insert: { active?: boolean; cost_per_unit?: number; created_at?: Ts; id?: string; min_stock?: number; name: string; restaurant_id: string; stock_qty?: number; unit?: Database['public']['Enums']['stock_unit']; updated_at?: Ts }
        Update: Partial<Database['public']['Tables']['ingredients']['Insert']>
        Relationships: []
      }
      modifier_groups: {
        Row: { created_at: Ts; id: string; max_select: number; min_select: number; name: string; restaurant_id: string; updated_at: Ts }
        Insert: { created_at?: Ts; id?: string; max_select?: number; min_select?: number; name: string; restaurant_id: string; updated_at?: Ts }
        Update: Partial<Database['public']['Tables']['modifier_groups']['Insert']>
        Relationships: []
      }
      modifiers: {
        Row: { active: boolean; created_at: Ts; group_id: string; id: string; name: string; price_delta: number; restaurant_id: string; sort_order: number; updated_at: Ts }
        Insert: { active?: boolean; created_at?: Ts; group_id: string; id?: string; name: string; price_delta?: number; restaurant_id: string; sort_order?: number; updated_at?: Ts }
        Update: Partial<Database['public']['Tables']['modifiers']['Insert']>
        Relationships: []
      }
      order_counters: {
        Row: { last_number: number; restaurant_id: string }
        Insert: { last_number?: number; restaurant_id: string }
        Update: Partial<Database['public']['Tables']['order_counters']['Insert']>
        Relationships: []
      }
      order_items: {
        Row: { created_at: Ts; created_by: string | null; guest_number: number | null; id: string; line_total: number | null; modifiers: Json; modifiers_total: number; name: string; notes: string | null; order_id: string; product_id: string | null; quantity: number; ready_at: Ts | null; restaurant_id: string; sent_at: Ts | null; station_id: string | null; status: Database['public']['Enums']['item_status']; unit_price: number; updated_at: Ts }
        Insert: { created_at?: Ts; created_by?: string | null; guest_number?: number | null; id?: string; modifiers?: Json; modifiers_total?: number; name: string; notes?: string | null; order_id: string; product_id?: string | null; quantity?: number; ready_at?: Ts | null; restaurant_id: string; sent_at?: Ts | null; station_id?: string | null; status?: Database['public']['Enums']['item_status']; unit_price: number; updated_at?: Ts }
        Update: Partial<Database['public']['Tables']['order_items']['Insert']>
        Relationships: []
      }
      orders: {
        Row: { cancelled_reason: string | null; cash_session_id: string | null; closed_at: Ts | null; created_at: Ts; created_by: string | null; customer_id: string | null; customer_name: string | null; discount_amount: number; guests: number | null; id: string; notes: string | null; number: number | null; opened_at: Ts; paid_total: number; restaurant_id: string; status: Database['public']['Enums']['order_status']; subtotal: number; table_id: string | null; total: number; type: Database['public']['Enums']['order_type']; updated_at: Ts; waiter_id: string | null }
        Insert: { cancelled_reason?: string | null; cash_session_id?: string | null; closed_at?: Ts | null; created_at?: Ts; created_by?: string | null; customer_id?: string | null; customer_name?: string | null; discount_amount?: number; guests?: number | null; id?: string; notes?: string | null; number?: number | null; opened_at?: Ts; paid_total?: number; restaurant_id: string; status?: Database['public']['Enums']['order_status']; subtotal?: number; table_id?: string | null; total?: number; type?: Database['public']['Enums']['order_type']; updated_at?: Ts; waiter_id?: string | null }
        Update: Partial<Database['public']['Tables']['orders']['Insert']>
        Relationships: []
      }
      payment_methods: {
        Row: { active: boolean; created_at: Ts; id: string; kind: Database['public']['Enums']['payment_kind']; name: string; restaurant_id: string; sort_order: number; updated_at: Ts }
        Insert: { active?: boolean; created_at?: Ts; id?: string; kind: Database['public']['Enums']['payment_kind']; name: string; restaurant_id: string; sort_order?: number; updated_at?: Ts }
        Update: Partial<Database['public']['Tables']['payment_methods']['Insert']>
        Relationships: []
      }
      payments: {
        Row: { amount: number; cash_session_id: string | null; created_at: Ts; created_by: string | null; id: string; order_id: string; payment_method_id: string; reference: string | null; restaurant_id: string; tip: number; updated_at: Ts; voided_at: Ts | null; voided_by: string | null }
        Insert: { amount: number; cash_session_id?: string | null; created_at?: Ts; created_by?: string | null; id?: string; order_id: string; payment_method_id: string; reference?: string | null; restaurant_id: string; tip?: number; updated_at?: Ts; voided_at?: Ts | null; voided_by?: string | null }
        Update: Partial<Database['public']['Tables']['payments']['Insert']>
        Relationships: []
      }
      product_modifier_groups: {
        Row: { created_at: Ts; group_id: string; product_id: string; restaurant_id: string; sort_order: number; updated_at: Ts }
        Insert: { created_at?: Ts; group_id: string; product_id: string; restaurant_id: string; sort_order?: number; updated_at?: Ts }
        Update: Partial<Database['public']['Tables']['product_modifier_groups']['Insert']>
        Relationships: []
      }
      products: {
        Row: { active: boolean; category_id: string | null; created_at: Ts; description: string | null; id: string; image_url: string | null; is_favorite: boolean; name: string; price: number; restaurant_id: string; sku: string | null; sort_order: number; station_id: string | null; updated_at: Ts }
        Insert: { active?: boolean; category_id?: string | null; created_at?: Ts; description?: string | null; id?: string; image_url?: string | null; is_favorite?: boolean; name: string; price?: number; restaurant_id: string; sku?: string | null; sort_order?: number; station_id?: string | null; updated_at?: Ts }
        Update: Partial<Database['public']['Tables']['products']['Insert']>
        Relationships: []
      }
      profiles: {
        Row: { created_at: Ts; full_name: string | null; id: string; updated_at: Ts }
        Insert: { created_at?: Ts; full_name?: string | null; id: string; updated_at?: Ts }
        Update: Partial<Database['public']['Tables']['profiles']['Insert']>
        Relationships: []
      }
      recipe_items: {
        Row: { created_at: Ts; ingredient_id: string; product_id: string; quantity: number; restaurant_id: string; updated_at: Ts }
        Insert: { created_at?: Ts; ingredient_id: string; product_id: string; quantity: number; restaurant_id: string; updated_at?: Ts }
        Update: Partial<Database['public']['Tables']['recipe_items']['Insert']>
        Relationships: []
      }
      registers: {
        Row: { active: boolean; created_at: Ts; id: string; name: string; restaurant_id: string; updated_at: Ts }
        Insert: { active?: boolean; created_at?: Ts; id?: string; name: string; restaurant_id: string; updated_at?: Ts }
        Update: Partial<Database['public']['Tables']['registers']['Insert']>
        Relationships: []
      }
      restaurant_members: {
        Row: { active: boolean; created_at: Ts; display_name: string | null; restaurant_id: string; role: Database['public']['Enums']['member_role']; updated_at: Ts; user_id: string }
        Insert: { active?: boolean; created_at?: Ts; display_name?: string | null; restaurant_id: string; role: Database['public']['Enums']['member_role']; updated_at?: Ts; user_id: string }
        Update: Partial<Database['public']['Tables']['restaurant_members']['Insert']>
        Relationships: [
          { foreignKeyName: 'restaurant_members_restaurant_id_fkey'; columns: ['restaurant_id']; isOneToOne: false; referencedRelation: 'restaurants'; referencedColumns: ['id'] },
        ]
      }
      suppliers: {
        Row: { active: boolean; created_at: Ts; cuit: string | null; email: string | null; id: string; name: string; notes: string | null; phone: string | null; restaurant_id: string; updated_at: Ts }
        Insert: { active?: boolean; cuit?: string | null; email?: string | null; id?: string; name: string; notes?: string | null; phone?: string | null; restaurant_id: string }
        Update: Partial<Database['public']['Tables']['suppliers']['Insert']>
        Relationships: []
      }
      purchases: {
        Row: { cancelled_at: Ts | null; category: Database['public']['Enums']['expense_category']; created_at: Ts; created_by: string | null; doc_kind: string; doc_number: string | null; due_on: string | null; id: string; issued_on: string; notes: string | null; restaurant_id: string; supplier_id: string; total: number }
        Insert: { id?: string }
        Update: { id?: string }
        Relationships: []
      }
      purchase_items: {
        Row: { description: string; id: string; ingredient_id: string | null; line_total: number; purchase_id: string; quantity: number; restaurant_id: string }
        Insert: { id?: string }
        Update: { id?: string }
        Relationships: []
      }
      supplier_movements: {
        Row: { amount: number; cash_movement_id: string | null; created_at: Ts; created_by: string | null; id: string; kind: 'purchase' | 'payment' | 'reversal'; note: string | null; payment_method_id: string | null; purchase_id: string | null; restaurant_id: string; supplier_id: string }
        Insert: { id?: string }
        Update: { id?: string }
        Relationships: []
      }
      customers: {
        Row: { active: boolean; created_at: Ts; credit_limit: number | null; doc_number: string | null; doc_type: number | null; email: string | null; id: string; iva_condition: number; name: string; notes: string | null; phone: string | null; restaurant_id: string; updated_at: Ts }
        Insert: { active?: boolean; credit_limit?: number | null; doc_number?: string | null; doc_type?: number | null; email?: string | null; id?: string; iva_condition?: number; name: string; notes?: string | null; phone?: string | null; restaurant_id: string }
        Update: Partial<Database['public']['Tables']['customers']['Insert']>
        Relationships: []
      }
      customer_movements: {
        Row: { amount: number; cash_movement_id: string | null; created_at: Ts; created_by: string | null; customer_id: string; id: string; kind: 'charge' | 'payment' | 'reversal'; note: string | null; order_id: string | null; payment_id: string | null; payment_method_id: string | null; restaurant_id: string }
        Insert: { id?: string }
        Update: { id?: string }
        Relationships: []
      }
      fiscal_settings: {
        Row: { activity_start: string | null; address: string; cuit: string; enabled: boolean; environment: string; gross_income: string | null; iva_condition: Database['public']['Enums']['iva_condition']; legal_name: string; point_of_sale: number; restaurant_id: string; updated_at: Ts }
        Insert: { activity_start?: string | null; address: string; cuit: string; enabled?: boolean; gross_income?: string | null; iva_condition: Database['public']['Enums']['iva_condition']; legal_name: string; point_of_sale: number; restaurant_id: string }
        Update: Partial<Database['public']['Tables']['fiscal_settings']['Insert']>
        Relationships: []
      }
      invoices: {
        Row: { associated_id: string | null; credit_note_id: string | null; reason: string | null; cae: string | null; cae_due: string | null; cbte_type: number; created_at: Ts; created_by: string | null; doc_number: string; doc_type: number; environment: string; error: string | null; id: string; issued_on: string; net: number; notes: string | null; number: number | null; order_id: string; point_of_sale: number; receiver_condition: number; receiver_name: string | null; restaurant_id: string; status: Database['public']['Enums']['invoice_status']; total: number; vat: number }
        Insert: { id?: string }
        Update: { id?: string }
        Relationships: []
      }
      mp_charges: {
        Row: { amount: number; created_at: Ts; created_by: string | null; error: string | null; expires_at: Ts | null; id: string; mp_order_id: string | null; mp_payment_id: string | null; order_id: string; payment_id: string | null; qr_data: string | null; restaurant_id: string; status: Database['public']['Enums']['mp_charge_status']; updated_at: Ts }
        Insert: { id?: string }
        Update: { id?: string }
        Relationships: []
      }
      restaurant_invites: {
        Row: { accepted_at: Ts | null; accepted_by: string | null; created_at: Ts; created_by: string; expires_at: Ts; id: string; restaurant_id: string; revoked_at: Ts | null; role: Database['public']['Enums']['member_role']; token: string }
        Insert: { accepted_at?: Ts | null; accepted_by?: string | null; created_at?: Ts; created_by?: string; expires_at?: Ts; id?: string; restaurant_id: string; revoked_at?: Ts | null; role: Database['public']['Enums']['member_role']; token?: string }
        Update: Partial<Database['public']['Tables']['restaurant_invites']['Insert']>
        Relationships: []
      }
      restaurants: {
        Row: { address: string | null; created_at: Ts; created_by: string | null; cuit: string | null; currency: string; id: string; legal_name: string | null; menu_note: string | null; menu_public: boolean; menu_slug: string | null; name: string; phone: string | null; timezone: string; updated_at: Ts }
        Insert: { address?: string | null; created_at?: Ts; created_by?: string | null; cuit?: string | null; currency?: string; id?: string; legal_name?: string | null; name: string; phone?: string | null; timezone?: string; updated_at?: Ts }
        Update: Partial<Database['public']['Tables']['restaurants']['Insert']>
        Relationships: []
      }
      stations: {
        Row: { active: boolean; created_at: Ts; id: string; name: string; restaurant_id: string; sort_order: number; updated_at: Ts }
        Insert: { active?: boolean; created_at?: Ts; id?: string; name: string; restaurant_id: string; sort_order?: number; updated_at?: Ts }
        Update: Partial<Database['public']['Tables']['stations']['Insert']>
        Relationships: []
      }
      stock_movements: {
        Row: { created_at: Ts; created_by: string | null; id: string; ingredient_id: string; note: string | null; order_id: string | null; qty_delta: number; reason: Database['public']['Enums']['stock_reason']; restaurant_id: string; unit_cost: number | null }
        Insert: { created_at?: Ts; created_by?: string | null; id?: string; ingredient_id: string; note?: string | null; order_id?: string | null; qty_delta: number; reason: Database['public']['Enums']['stock_reason']; restaurant_id: string; unit_cost?: number | null }
        Update: Partial<Database['public']['Tables']['stock_movements']['Insert']>
        Relationships: []
      }
      tables: {
        Row: { active: boolean; area_id: string; created_at: Ts; id: string; name: string; pos_x: number; pos_y: number; restaurant_id: string; seats: number; sort_order: number; updated_at: Ts }
        Insert: { active?: boolean; area_id: string; created_at?: Ts; id?: string; name: string; pos_x?: number; pos_y?: number; restaurant_id: string; seats?: number; sort_order?: number; updated_at?: Ts }
        Update: Partial<Database['public']['Tables']['tables']['Insert']>
        Relationships: []
      }
    }
    Views: {
      supplier_balances: {
        Row: { balance: number; id: string; restaurant_id: string }
        Relationships: []
      }
      customer_balances: {
        Row: { balance: number; id: string; last_movement_at: Ts | null; restaurant_id: string }
        Relationships: []
      }
    }
    Functions: {
      accept_invite: {
        Args: { p_token: string }
        Returns: string
      }
      public_menu: {
        Args: { p_slug: string }
        Returns: Json
      }
      set_public_menu: {
        Args: { p_restaurant: string; p_slug: string; p_public: boolean; p_note?: string }
        Returns: string
      }
      supplier_payment: {
        Args: { p_supplier: string; p_amount: number; p_method: string; p_note?: string }
        Returns: number
      }
      register_purchase: {
        Args: { p_purchase: Json }
        Returns: string
      }
      cancel_purchase: {
        Args: { p_purchase: string; p_reason?: string }
        Returns: undefined
      }
      customer_payment: {
        Args: { p_customer: string; p_amount: number; p_method: string; p_note?: string }
        Returns: number
      }
      merge_orders: {
        Args: { p_target: string; p_source: string }
        Returns: string
      }
      invite_preview: {
        Args: { p_token: string }
        Returns: Json
      }
      close_cash_session: {
        Args: { p_counted: number; p_notes?: string; p_session: string }
        Returns: Database['public']['Tables']['cash_sessions']['Row']
      }
      create_restaurant: {
        Args: { p_name: string; p_tables?: number }
        Returns: string
      }
      income_statement: {
        Args: { p_restaurant: string; p_months?: number }
        Returns: Json
      }
      sales_report: {
        Args: { p_restaurant: string; p_from: string; p_to: string }
        Returns: Json
      }
      stock_count: {
        Args: { p_ingredient: string; p_counted: number; p_note?: string }
        Returns: number
      }
    }
    Enums: {
      item_status: 'pending' | 'sent' | 'preparing' | 'ready' | 'delivered' | 'cancelled'
      expense_category: 'mercaderia' | 'bebidas' | 'descartables' | 'servicios' | 'alquiler' | 'sueldos' | 'impuestos' | 'mantenimiento' | 'otros'
      iva_condition: 'monotributo' | 'responsable_inscripto'
      invoice_status: 'pending' | 'authorized' | 'rejected'
      mp_charge_status: 'created' | 'processed' | 'canceled' | 'expired' | 'refunded' | 'failed'
      member_role: 'owner' | 'manager' | 'cashier' | 'waiter' | 'kitchen'
      order_status: 'open' | 'closed' | 'cancelled'
      order_type: 'dine_in' | 'counter' | 'takeaway' | 'delivery'
      payment_kind: 'cash' | 'debit' | 'credit' | 'transfer' | 'mercadopago' | 'other' | 'account'
      stock_reason: 'sale' | 'sale_reversal' | 'purchase' | 'adjustment' | 'waste' | 'count'
      stock_unit: 'unit' | 'g' | 'kg' | 'ml' | 'l'
    }
    CompositeTypes: { [_ in never]: never }
  }
}

type PublicSchema = Database['public']
export type Tables<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Row']
export type TablesInsert<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Insert']
export type Enums<T extends keyof PublicSchema['Enums']> = PublicSchema['Enums'][T]
