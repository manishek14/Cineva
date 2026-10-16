import { DataSource } from 'typeorm';
import { configuration } from '../config/configuration';

const config = configuration();
const host = String(config.DATABASE_HOST ?? 'localhost');
const port = Number(config.DATABASE_PORT ?? 5432);
const user = String(config.DATABASE_USER ?? 'cineva');
const password = String(config.DATABASE_PASSWORD ?? '');
const database = String(config.DATABASE_NAME ?? 'cineva');
const schema = String(config.DATABASE_SCHEMA ?? 'public');

/**
 * Standalone DataSource for CLI: `npm run migration:generate` and
 * `npm run migration:run`. It mirrors what TypeOrmModule.forRootAsync
 * builds at runtime; keep them in sync.
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  host,
  port,
  username: user,
  password,
  database,
  schema,
  synchronize: false,
  logging: Boolean(config.DATABASE_LOGGING),
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/database/migrations/**/*.ts'],
  migrationsTableName: '__typeorm_migrations',
});
