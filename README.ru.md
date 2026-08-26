# dsh-acp

Адаптер [ACP (Agent Client Protocol)][acp], который раскрывает **DeepSeek
Harness (DSH)** как ACP-сервер через stdin/stdout, чтобы ACP-клиенты — плагин
**Agent Client** в Obsidian, клиенты Claude Code, редакторы — могли управлять
DSH через локальный CLI `dsh`.

Каждый ход (prompt turn) порождает новый запуск

```text
dsh --profile headless "<prompt>"
```

(одноразовую, не сохраняющую состояния задачу), повторяя подход, которым
`claude-agent-acp` оборачивает Claude Code. Вывод транслируется клиенту обратно
в виде обновлений `agent_message_chunk`, после чего возвращается финальный
результат `end_turn`.

Репозиторий содержит две дополняющие друг друга части:

1. **`dsh-acp.mjs`** — автономный бинарник ACP-сервера (`bin: dsh-acp`).
   GUI ACP-клиенты запускают его напрямую как дочерний процесс.
2. **`index.mjs`** — [cordis][cordis]-плагин, который регистрирует сервис
   `dsh.acp` и управляет процессом адаптера *внутри* harness; используется через
   `dsh plugin --profile <name> add dsh-acp`.

## Как это работает

```text
Obsidian Agent Client ──(ACP JSON-RPC через stdin/stdout)──▶ dsh-acp ──spawn──▶ dsh --profile headless "<prompt>"
                                   ▲  session/update чанки                      │
                                   └──────────────── stdout стримится обратно ───┘
```

- ACP v1 (JSON-RPC с разделителями-переводами строк) через stdin/stdout процесса.
- Потоковое возвращение вывода DSH в виде обновлений `agent_message_chunk`, затем
  возвращается `result` (`stopReason: "end_turn"`).
- Сессии не хранят состояние (каждый ход независим); `cwd` учитывается.

## Требования

- Node.js >= 22.13
- Работоспособный бэкенд `dsh` (см. [Подготовка headless-профиля](#подготовка-headless-профиля))

## Файлы

| Путь | Назначение |
|------|------------|
| `dsh-acp.mjs` | Автономный бинарник ACP-сервера (`bin: dsh-acp`) |
| `index.mjs` | Точка входа cordis-плагина (сервис `dsh.acp` + менеджер процесса адаптера) |
| `cordis.patch.yml` | Слой вставки плагина для `dsh plugin ... add dsh-acp` |
| `scripts/dsh-acp.js` | Адаптер ACP-сервера (рабочая справочная копия) |
| `scripts/test-client.js` | Клиентское тестовое окружение ACP для автономной проверки |

## Автономное использование

После установки пакета (или прямо из клонированного репозитория):

```bash
node dsh-acp.mjs            # обслуживать ACP v1 на stdin/stdout
node scripts/test-client.js "reply with just the word HELLO"
```

### Конфигурация (Obsidian Agent Client)

Отредактируйте `<vault>/.obsidian/plugins/agent-client/data.json` (или используйте
интерфейс настроек плагина) → добавьте Custom Agent:

```json
{
  "id": "dsh-acp",
  "displayName": "DeepSeek Harness (ACP)",
  "command": "/absolute/path/to/dsh-acp/dsh-acp.mjs",
  "args": [],
  "env": [{ "name": "DSH_ACP_LOG_DIR", "value": "/absolute/path/to/dsh-acp/logs" }]
}
```

Убедитесь, что **nodePath** плагина указывает на настоящий бинарник `node`, чтобы
корректно обрабатывался shebang, затем перезагрузите Obsidian и выберите
*DeepSeek Harness (ACP)* в выборе агента.

### Переменные окружения

| Переменная | Значение | По умолчанию |
|--------|---------|---------|
| `DSH_BIN` | исполняемый файл `dsh` | `dsh` из PATH |
| `DSH_PROFILE` | запускаемый профиль | `headless` |
| `DSH_ARGS` | дополнительные аргументы перед промптом (через пробел) | *отсутствуют* |
| `DSH_ACP_LOG_DIR` | каталог для журнала выполнения | *выключено* |

## Использование cordis-плагина

Установите в профиль DSH и включите запись:

```bash
dsh plugin --profile web add dsh-acp
```

Плагин считывает `cordis.patch.yml`, вставляет запись `dsh-acp` в дерево плагинов
профиля, после чего предоставляет сервис `dsh.acp`:

- `ctx.get("dsh.acp")` — экземпляр `DshAcpService`.
- `service.start()` / `service.stop()` — запуск / завершение дочернего процесса
  адаптера.
- `service.process` — активный `ChildProcess` (null, когда не запущен).

Конфигурация (предоставляется загрузчиком):

```yaml
# пример записи cordis.patch.yml
- id: dsh-acp
  name: dsh-acp
  config:
    spawn: true        # запустить адаптер на app/ready
    profile: headless  # профиль DSH для адаптера
    env: {}            # дополнительные переменные окружения для процесса адаптера
```

## Подготовка headless-профиля

`dsh --profile headless` требует провайдера модели по умолчанию, который сможет
разрешить headless-профиль. Если глобальный `$DSH_HOME/settings.yaml` закрепляет
провайдера «только для web» (например, `my-web-only-provider`), задайте для
headless-профиля собственные настройки:

- `~/.dsh/profiles/headless/settings.yaml` — маршрут `llm-pi-ai` +
  `agent-default-model`.
- `~/.dsh/profiles/headless/cordis.patch.yml` — смонтируйте этот файл настроек через
  переопределение id `settings` и задайте `agent-default-model`.

## Лицензия

[MIT](LICENSE)

[acp]: https://github.com/evalstate/agent-client-protocol
[cordis]: https://github.com/cordiverse/cordis
