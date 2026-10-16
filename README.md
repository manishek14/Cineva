# Cineva — سامانه رزرو و فروش بلیت سینما

<p dir="rtl">
<b>Cineva</b> یک بک‌اند کامل برای سامانه رزرو و فروش بلیت سینماست که با
<code>NestJS</code>، <code>TypeORM</code>، <code>PostgreSQL</code>،
<code>Redis</code> و <code>BullMQ</code> پیاده‌سازی شده. هدف این پروژه
علاوه بر پوشش قابلیت‌های معمول رزرو، حل مسائل مهم مهندسی بک‌اند
مثل هم‌زمانی، تراکنش، پرداخت تکراری، انقضای رزرو، یکپارچگی داده و
بازیابی خطا به‌شکل قابل‌آزمایش است.
</p>

---

## فهرست

1. [تصمیم‌های فنی کلیدی](#تصمیم‌های-فنی-کلیدی)
2. [معماری و ساختار ماژول‌ها](#معماری-و-ساختار-ماژول‌ها)
3. [راه‌اندازی محیط توسعه](#راه‌اندازی-محیط-توسعه)
4. [اجرای مایگریشن‌ها](#اجرای-مایگریشن‌ها)
5. [راهنمای API](#راهنمای-api)
6. [جریان کامل رزرو تا ورود](#جریان-کامل-رزرو-تا-ورود)
7. [تضمین «فروش دوباره نیست»](#تضمین-فروش-دوباره-نیست)
8. [سیاست لغو و بازپرداخت](#سیاست-لغو-و-بازپرداخت)
9. [درگاه پرداخت](#درگاه-پرداخت)
10. [تست](#تست)

---

## تصمیم‌های فنی کلیدی

| موضوع | تصمیم |
| --- | --- |
| بک‌اند | NestJS 12 با معماری Modular Monolith |
| ORM | TypeORM 0.3.20 (entity-decorator + good partial unique index support) |
| دیتابیس اصلی | PostgreSQL 16 |
| نگه‌داری موقت صندلی | Redis با TTL و شناسه مالک (Lua scripts برای عملیات اتمیک) |
| پردازش پس‌زمینه | BullMQ برای انقضا و کارهای قابل‌تکرار |
| احراز هویت | OTP آزمایشی در محیط توسعه + JWT (Access 15m + Refresh 7d با rotation و blacklist) |
| مهلت رزرو موقت | ۱۰ دقیقه (با کف ۲× کل TTL برای تمدید) |
| پرداخت | قرارداد `PaymentProviderPort` با دو adapter: `MockPaymentProvider` (تست) و `ZarinpalPaymentProvider` (تولیدی، `https://payment.zarinpal.com`) |
| قیمت‌گذاری | `base_price_toman × category.base_price_multiplier` که هنگام ساخت سانس به‌صورت snapshot در `screening_seats.price` ذخیره می‌شود |
| لغو | ۱۵٪ جریمه، ۸۵٪ بازپرداخت (قابل تنظیم مدیر)؛ ممنوعیت لغو در ۳۰ دقیقه پایانی (کف ۱۵ دقیقه از env) |
| تست | Unit + Integration + Concurrency (race روی آخرین صندلی) |

---

## معماری و ساختار ماژول‌ها

```
src/
├── app.module.ts            # ریشه AppModule
├── main.ts                  # bootstrap: Helmet, Swagger, ValidationPipe
├── config/                  # env validation + configuration
├── common/                  # پایه‌های مشترک
│   ├── constants/          # state machines, error codes, ROLES
│   ├── decorators/         # @Public, @Roles
│   ├── filters/            # global HttpExceptionFilter
│   ├── interceptors/        # request logging + traceId
│   ├── redis/              # RedisModule + RedisService (Lua seat-hold)
│   └── utils/             # BusinessError helper
├── catalog/                # Movie + SeatCategory
├── hall/                   # CinemaHall + Seat (unique per hall)
├── screening/             # Screening + ScreeningSeat (+ EXCLUDE constraint)
├── auth/                   # User + OtpChallenge + JwtStrategy + Guards
├── reservation/           # Reservation + ReservationSeat + SeatAllocation
├── payment/               # Payment + MockProvider + ZarinpalProvider
├── ticket/                # Ticket (QR + atomic scan)
├── cancellation/          # CancellationPolicy + Refund
├── jobs/                  # BullMQ: reservation-expiry + reconciliation
└── audit/                 # AuditLog + Transactional Outbox
```

هر ماژول مستقل است و از طریق قراردادهای مشخص (`services` و `ports`) با
دیگر ماژول‌ها ارتباط دارد. ماژول پرداخت مستقیماً وضعیت صندلی را در
Redis تغییر نمی‌دهد و ماژول بلیت نیز بدون تأیید معتبر رزرو، بلیت صادر
نمی‌کند.

---

## راه‌اندازی محیط توسعه

### پیش‌نیازها

- Node.js ≥ 24
- Docker و Docker Compose (برای اجرای PostgreSQL + Redis)
- npm ≥ 11

### ۱. نصب وابستگی‌ها

```bash
git clone https://github.com/manishek14/Cineva.git
cd Cineva
npm install
```

### ۲. راه‌اندازی دیتابیس و Redis با docker-compose

```bash
cp .env.example .env
docker compose up -d
```

این دستور اجرا می‌کند:

- PostgreSQL 16 روی پورت `5432` با دیتابیس `cineva` و کاربر `cineva`
- Redis 7 روی پورت `6379` با persistence
- pgAdmin روی پورت `5050` (لاگین: `admin@cineva.local` / `admin`)
- BullMQ Board روی پورت `5051` (مشاهده‌ی صف‌ها)

### ۳. اجرای مایگریشن‌ها

```bash
npm run migration:run
```

این دستور دو مایگریشن مهم را اجرا می‌کند:

- `0001-ScreeningOverlapExclude`: اضافه‌کردن **EXCLUDE constraint** GiST روی
  بازه‌ی زمانی سانس‌ها در یک سالن (جلوگیری هم‌پوشانی در سطح دیتابیس)
- `0002-SeatAllocationUnique`: اضافه‌کردن **partial unique index** روی
  `seat_allocations(screening_seat_id) WHERE status IN ('Held','Sold')` —
  تضمین اینکه هر صندلی در هر لحظه حداکثر یک مالک فعال دارد

### ۴. اجرای اپ

```bash
npm run start:dev
```

سپس:

- API: <http://localhost:3000/api/v1>
- Swagger UI: <http://localhost:3000/docs>
- BullMQ Board: <http://localhost:5051>
- pgAdmin: <http://localhost:5050>

---

## راهنمای API

همه‌ی endpointها (به‌جز `health` و `auth/otp/*` و `payment/callback/*`)
نیاز به Bearer Access Token دارند. نقش‌ها:

| نقش | کلید | توضیح |
| --- | --- | --- |
| مشتری | `customer` | رزرو، پرداخت، مشاهده/لغو سفارش خود |
| متصدی ورودی | `gate_attendant` | اسکن QR بلیت |
| اپراتور سینما | `cinema_operator` | رسیدگی به سفارش‌ها، لغو سانس |
| مدیر سینما | `cinema_manager` | مدیریت کاتالوگ، سالن، سانس، سیاست لغو |
| مدیر فنی | `tech_admin` | تنظیمات سامانه، تخصیص نقش |

### auth

- `POST /api/v1/auth/otp/request` — درخواست OTP (در محیط توسعه، کد در لاگ سرور چاپ می‌شود: پیش‌فرض `111111`)
- `POST /api/v1/auth/otp/verify` — تأیید OTP و دریافت Access + Refresh
- `POST /api/v1/auth/refresh` — تعویض توکن‌ها (Refresh Rotation)
- `POST /api/v1/auth/logout` — ابطال Refresh فعلی

### catalog

- `POST /api/v1/movies` (manager)
- `GET /api/v1/movies`
- `PATCH /api/v1/movies/:id` (manager)
- `DELETE /api/v1/movies/:id` (manager — soft archive)
- `POST /api/v1/seat-categories` (manager)
- `GET /api/v1/seat-categories`

### hall

- `POST /api/v1/halls` (manager)
- `GET /api/v1/halls`
- `POST /api/v1/halls/:hallId/seats/bulk` (manager)
- `GET /api/v1/halls/:hallId/seats`
- `PATCH /api/v1/halls/:hallId/seats/:seatId/maintenance`

### screening

- `POST /api/v1/screenings` (manager) — همراه با تولید خودکار `screening_seats` و snapshot قیمت
- `GET /api/v1/screenings` — با فیلتر `movieId` / `hallId` / `status` / `startsAfter`
- `GET /api/v1/screenings/:id`
- `GET /api/v1/screenings/:id/seat-map` — نقشه‌ی صندلی‌ها با وضعیت فروش فعلی
- `POST /api/v1/screenings/:id/cancel` (manager/operator)

### reservation

- `POST /api/v1/reservations` — انتخاب تعداد + صندلی (اتمیک all-or-nothing)
- `GET /api/v1/reservations/mine`
- `GET /api/v1/reservations/:id`
- `POST /api/v1/reservations/:id/extend` — تمدید TTL (با کف)
- `POST /api/v1/reservations/:id/cancel` — لغو قبل از پرداخت

### payment

- `POST /api/v1/payments/initiate` — ساخت Payment + بازگشت `gatewayRedirectUrl`
- `GET /api/v1/payments/:id`
- `GET /api/v1/payments/reservation/:reservationId`
- `GET /api/v1/payment/callback/zarinpal` (public — هدف callback مرورگر)

### ticket

- `GET /api/v1/tickets/:id` — بدون plaintext QR token
- `GET /api/v1/tickets/reservation/:reservationId`
- `POST /api/v1/tickets/scan` (gate_attendant/operator/manager) — اسکن اتمیک QR

### cancellation

- `POST /api/v1/cancellation/policies` (manager)
- `GET /api/v1/cancellation/policies` (manager)
- `PATCH /api/v1/cancellation/policies/:id` (manager)
- `POST /api/v1/cancellation/reservations/:reservationId` — لغو سفارش Confirmed با سیاست فعال
- `GET /api/v1/cancellation/reservations/:reservationId/refunds`

---

## جریان کامل رزرو تا ورود

<p dir="rtl">این یک جریان کامل end-to-end است که می‌توانید با Swagger یا curl اجرا کنید:</p>

```text
1. POST /auth/otp/request { phone: "+98912..." }
   └─ server logs: [DEV OTP] phone=... code=111111

2. POST /auth/otp/verify { phone, code } → { accessToken, refreshToken }

3. POST /movies { title, durationMinutes, ageRating }      (manager)
4. POST /seat-categories { name:"VIP", code:"VIP", basePriceMultiplier:1.5 } (manager)
5. POST /halls { name:"Salon 1", slug:"salon-1" }            (manager)
6. POST /halls/:hallId/seats/bulk { seats:[{categoryId, rowLabel:"A", seatNumber:1..N, positionX, positionY}] }
7. POST /screenings { movieId, hallId, startsAt, endsAt, basePriceToman:200000 } (manager)
   └─ auto-generates screening_seats with price = base × multiplier snapshot

8. GET /screenings/:id/seat-map → choose seat IDs

9. POST /reservations { screeningId, screeningSeatIds:[...] }
   └─ Redis atomic hold + PostgreSQL SERIALIZABLE tx + partial unique index
   └─ returns reservation with status=PendingPayment, expiresAt=+10min

10. POST /payments/initiate { reservationId }
    └─ calls provider.initiate (Mock or Zarinpal)
    └─ returns gatewayRedirectUrl

11. Customer opens gatewayRedirectUrl → authorizes payment
    └─ browser redirects to /payment/callback/zarinpal?paymentId=...&Authority=...&Status=OK

12. Server (public callback handler) → provider.verify (server-to-server)
    └─ if succeeds AND reservation still PendingPayment → confirmReservation
        (SERIALIZABLE tx, allocations Held→Sold, screening_seats Held→Sold,
         reservation_seats Held→Sold)
    └─ if succeeds BUT reservation Expired/Cancelled → lateCallback=true,
        payment marked Succeeded but routed to refund pipeline (no tickets)

13. Post-confirm: outbox event for ticket issuance →
    TicketService.issueForReservation generates QR-backed tickets
    (qrTokenHash bcrypt, plaintext returned once)

14. POST /tickets/scan { qrToken } (gate_attendant at cinema entrance)
    └─ ATOMIC Valid→Used via SELECT FOR UPDATE + state machine check
    └─ two concurrent scans cannot both succeed
```

---

## تضمین «فروش دوباره نیست»

<p dir="rtl">مهم‌ترین تصمیم فنی Cineva این است که هرگز یک صندلی به دو مشتری فروخته نمی‌شود، حتی اگر:</p>

- دو درخواست هم‌زمان روی آخرین صندلی رقابت کنند
- Redis از کار بیفتد یا restart شود
- Worker خاموش باشد و job انقضا اجرا نشود
- callback پرداخت دیررس باشد

### لایه‌های دفاعی

1. **Redis pre-flight (سریع)**: `acquireHoldsAllOrNothing` یک Lua script است که برای هر صندلی `SET NX EX` می‌زند و اگر حتی یکی شکست بخورد، همه را با بررسی مالکیت آزاد می‌کند. اگر کلید در Redis منقضی شود، تخصیص در PostgreSQL هنوز معتبر است.

2. **PostgreSQL SERIALIZABLE tx**: داخل تراکنش `SERIALIZABLE`، INSERT ردیف‌های `seat_allocations` با **partial unique index** `(screening_seat_id) WHERE status IN ('Held','Sold')` محافظت می‌شود. دو tx هم‌زمان که سعی کنند Held روی همان صندلی داشته باشند، فقط یکی موفق می‌شود؛ دیگری `unique_violation` (PG 23505) می‌گیرد.

3. **تمامی-یا-هیچ**: اگر هر صندلی شکست بخورد، کل رزرو rollback می‌شود و همه‌ی Redis holds با بررسی مالکیت پاک می‌شوند (هرگز به‌سادگی `DEL` نمی‌کنیم تا hold مشتری دیگر را پاک نکنیم).

4. **تأیید اتمیک پرداخت**: `confirmReservation` در `SERIALIZABLE` با `pessimistic_write` lock روی ردیف reservation. اگر callback پنج بار برسد، فقط یک‌بار tickets صادر می‌شود (idempotent از طریق state machine + `expire_processed_at`).

5. **انقضای server-authoritative**: `Reservation.expiresAt` در PostgreSQL است؛ زمان‌سنج مرورگر فقط نمایشی است. Worker انقضا قبل از عمل، وضعیت واقعی را از دیتابیس می‌خواند.

6. **Reconciliation**: worker دوره‌ای هر ۱ دقیقه، رزروهای منقضی‌شده‌ای که job آن‌ها گم شده را پیدا و پردازش می‌کند (در صورت قطعی Worker).

---

## سیاست لغو و بازپرداخت

<p dir="rtl">سیاست پایه (قابل تنظیم مدیر از طریق <code>CancellationPolicyEntity</code>):</p>

- **جریمه پیش‌فرض**: ۱۵٪ مبلغ بلیت‌های لغوشده
- **بازپرداخت پیش‌فرض**: ۸۵٪ مبلغ مشمول بازپرداخت
- **ممنوعیت لغو مشتری**: از ۳۰ دقیقه مانده به شروع سانس به بعد (قابل تنظیم مدیر به سمت بالا؛ **کف سخت ۱۵ دقیقه** از env غیرقابل دورزدن)
- **هزینه جانبی**: قابل تنظیم مدیر

### مثال محاسبه

اگر مشتری ۳ بلیت با مجموع قیمت ۹۰۰٬۰۰۰ تومان داشته باشد و همه را در
بازه مجاز لغو کند:

- جریمه: ۱۳۵٬۰۰۰ تومان (۱۵٪)
- بازپرداخت: ۷۶۵٬۰۰۰ تومان (۸۵٪)
- snapshot در `RefundEntity` ذخیره می‌شود

---

## درگاه پرداخت

### Mock (پیش‌فرض محیط توسعه)

تنظیم `PAYMENT_PROVIDER=mock` در `.env`. در Mock:

- `initiate` یک `authority` و `redirectUrl` برمی‌گرداند
- `verify` نتیجه را از query param `status` در callback می‌خواند
- برای شبیه‌سازی سناریوهای مختلف، کافی است URL redirect را با `Status=NOK` یا مقادیر دیگر بازگردانی کنید

### Zarinpal (تولیدی)

تنظیم `PAYMENT_PROVIDER=zarinpal` و مقداردهی `ZARINPAL_MERCHANT_ID`.

- `initiate`: POST به `https://api.zarinpal.com/pg/v1/payment/request.json`
- `verify`: POST به `https://api.zarinpal.com/pg/v1/payment/verify.json`
- redirect به `https://payment.zarinpal.com/pg/StartPay/{authority}`
- callback به `ZARINPAL_CALLBACK_URL` (پیش‌فرض: `http://localhost:3000/api/v1/payment/callback/zarinpal`)

### Late-callback handling

اگر callback پس از انقضای رزرو برسد (مرورگر بسته شد یا کاربر دیر بازگشت):

1. Payment در gateway موفق است (server-to-server verify)
2. ولی reservation در وضعیت Expired/Cancelled است
3. **هرگز** رزرو جدید برای همان صندلی ساخته نمی‌شود
4. Payment با `lateCallback=true` و `status=Succeeded` علامت‌گذاری می‌شود
5. Refund خودکار در pipeline بعدی (CancellationModule) پردازش می‌شود

---

## تست

```bash
npm test            # unit + integration
npm run test:e2e    # end-to-end (requires docker compose up)
npm run test:cov    # coverage report
```

### سناریوهای کلیدی پوشش‌داده‌شده

- **رقابت روی آخرین صندلی**: دو درخواست هم‌زمان فقط یکی موفق می‌شود
- **All-or-nothing چندصندلی**: شکست یک صندلی کل رزرو را rollback می‌کند
- **انقضای TTL**: ظرفیت قابل فروش مجدد می‌شود
- **انقضای Redis بدون تأثیر**: کلید Redis منقضی، رزرو هنوز فعال اگر DB بگوید
- **callback تکراری**: فقط یک نتیجه مالی + یک مجموعه بلیت
- **پرداخت موفق دیررس**: هیچ فروش دوباره‌ای رخ نمی‌دهد
- **اسکن اتمیک QR**: دو اسکن هم‌زمان فقط یکی موفق می‌شود
- **OTP منقضی/مصرف‌شده**: قابل تأیید مجدد نیست
- **کنترل مالکیت**: مشتری نمی‌تواند سفارش دیگری را مشاهده/لغو کند
- **Reconciliation پس از اختلال Worker**: رزروهای گم‌شده بازیابی می‌شوند

---

## وضعیت پروژه

<p dir="rtl">این نسخه‌ی ۱.۰ ساختاری کامل را ارائه می‌دهد. برای راه‌اندازی در محیط تولید:</p>

- فعال‌سازی HTTPS و تنظیم CORS به دامنه‌ی واقعی
- فعال‌سازی `PAYMENT_PROVIDER=zarinpal` با `MERCHANT_ID` واقعی
- فعال‌سازی `OTP_DEV_PRINT_TO_LOG=false` و اتصال به سرویس SMS واقعی
- تنظیم `JWT_ACCESS_SECRET` و `JWT_REFRESH_SECRET` با مقادیر ≥ ۳۲ کاراکتر
- فعال‌سازی rate limiting و WAF
- راه‌اندازی monitoring (Prometheus / Grafana)

---

## مجوز

MIT
