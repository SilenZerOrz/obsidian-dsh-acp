# obsidian-dsh-acp

`obsidian-dsh-acp` — это **ACP (Agent Client Protocol)**-плагин/адаптер, который
связывает **DeepSeek Harness (DSH)** с **Obsidian**. Настройте его как *Custom
Agent* в плагине **Agent Client** в Obsidian (или установите как cordis-плагин
в профиль DSH) — и вы сможете управлять DSH прямо из Obsidian: запускать диалоги
и задачи DeepSeek Harness, не выходя из приложения.

Это **ACP-сервер** (говорит на ACP v1 через stdin/stdout), который стоит между
Obsidian и DSH:

```text
Obsidian (плагин Agent Client)
      │  ① запускается как Custom Agent по протоколу ACP
      ▼
obsidian-dsh-acp (ACP-сервер)
      │  ② один prompt на ход
      ▼
dsh --profile headless "<prompt>"   (одноразовая задача DeepSeek Harness)
```

Он повторяет подход `claude-agent-acp` к обёртке Claude Code. Каждый ход (prompt turn):
- запускает свежий `dsh --profile headless "<prompt>"` (одноразовую задачу);
- потоково возвращает вывод DSH как обновления `agent_message_chunk`;
- по завершении возвращает результат `end_turn`.

Также поддерживается управление сессиями: постоянный список сессий (чтобы
"Session history" в Obsidian могла перезагружать реальные сессии), ветвление
сессий `session/fork` и зеркалирование каждого хода в архив DSH.

Репозиторий содержит две дополняющие друг друга части:

1. **`dsh-acp.mjs`** — автономный бинарник ACP-сервера (`bin: dsh-acp`).
   GUI ACP-клиенты (Obsidian Agent Client) запускают его напрямую как дочерний процесс.
2. **`index.mjs`** — [cordis][cordis]-плагин, который регистрирует сервис
   `dsh.acp` и управляет процессом адаптера *внутри* harness; используется через
   `dsh plugin --profile <name> add obsidian-dsh-acp`.

## Как это работает

```text
Obsidian Agent Client ──(ACP JSON-RPC через stdin/stdout)──▶ dsh-acp ──spawn──▶ dsh --profile headless "<prompt>"
                                   ▲  session/update чанки                      │
                                   └──────────────── stdout стримится обратно ───┘
```

- ACP v1 (JSON-RPC с разделителями-переводами строк) через stdin/stdout процесса.
- Потоковое возвращение вывода DSH как обновлений `agent_message_chunk`, затем
  возвращается `result` (`stopReason: "end_turn"`).
- Учитывается `cwd`; постоянный слой сессий делает управление сессиями удобным.

## Возможности сессий

Помимо модели «один ход без состояния», `dsh-acp` добавляет постоянный слой
сессий (`archive-store.mjs`), который обеспечивает три вещи:

1. **Перезагрузка списка сессий** — `session/list` возвращает устойчивые сессии
   из JSON-индекса на диске (по умолчанию `~/.dsh-acp/dsh-acp-sessions.json`),
   поэтому перезагрузка «Session history» в Obsidian показывает реальные сессии
   даже после перезапуска адаптера. При инициализации адаптер объявляет
   `sessionCapabilities.list`.
2. **Ветвление (fork) сессии** — `session/fork` глубоко копирует историю
   сообщений исходной сессии в новый id сессии, фиксирует связь с родителем и
   объявляет `sessionCapabilities.fork`, так что действие «fork» клиента работает.
3. **Резервная копия каждого хода** — каждый завершённый ход (пользователь +
   ассистент) дописывается в архив событий в формате DSH:
   `<DSH_HOME>/dsh-acp-archives/<encoded-cwd>/session-<id>/session.jsonl`.
   Он хранится в `dsh-acp-archives/` (а не в `sessions/` веб-процесса), чтобы
   обычный `.jsonl` не конфликтовал со zstd-сжатыми журналами сессий основного
   процесса. Задайте `DSH_ACP_ARCHIVE_IN_MAIN=1`, чтобы помещать архив в
   `sessions/` вместо этого (только если вы запускаете архив в том же режиме
   сжатия).

4. **Окончательное удаление сессии (v0.1.4)** — `session/delete` удаляет запись
   сессии **и** дисковой каталог архива в обоих корнях
   (`<DSH_HOME>/dsh-acp-archives/` и `<DSH_HOME>/sessions/`; каталог назван по
   ключу `session-<uuid>` записи), поэтому удалённая сессия не «воскресает» при
   следующем `list`. Адаптер объявляет `sessionCapabilities.delete`.

`session/resume` и `session/load` заново открывают сохранённую сессию.

> **Устойчивость и конкурентность (v0.1.4)**: индекс сессий в памяти
> сохраняется с коротким дебаунсом (`DSH_ACP_PERSIST_DEBOUNCE_MS`) и сбрасывается
> перед выходом, так что всплески сообщений сливаются в несколько операций записи;
> несколько процессов адаптера, разделяющих одно хранилище, перед записью
> объединяют свои данные с диском и никогда не воскрешают удалённую запись.
> Полный журнал изменений REQ — в `docs/计划/开发现状.md`.

## Требования

- Node.js >= 22.13
- Работоспособный бэкенд `dsh` (см. [Подготовка headless-профиля](#подготовка-headless-профиля))

## Файлы

| Путь | Назначение |
|------|------------|
| `dsh-acp.mjs` | Автономный бинарник ACP-сервера (`bin: dsh-acp`) |
| `archive-store.mjs` | Постоянное хранилище сессий + запись архива в формате DSH |
| `index.mjs` | Точка входа cordis-плагина (сервис `dsh.acp` + менеджер процесса адаптера) |
| `cordis.patch.yml` | Слой вставки плагина для `dsh plugin ... add obsidian-dsh-acp` |
| `scripts/dsh-acp.js` | Адаптер ACP-сервера (рабочая справочная копия) |
| `scripts/test-client.js` | Клиентское тестовое окружение ACP для автономной проверки |
| `acp-feature-test.mjs` | Протокольный функциональный тест (list / fork / resume / archive) |
| `install.sh` | Установщик в один клик (профиль DSH + custom agent Obsidian) |
| `README.zh-CN.md` | Документация на китайском (Chinese) |
| `README.ru.md` | Документация на русском (Russian) |

## Быстрая установка (в один клик)

В пакете есть `install.sh` — параметризованный установщик, который: (a) устанавливает
плагин в профиль DSH через официальный путь `dsh plugin add` и (b) настраивает
custom agent для плагина **Agent Client** в Obsidian, с опциональной конфигурацией
окружения. Он **идемпотентен**, **создаёт резервные копии** перед изменением
любого файла, поддерживает **любой Obsidian vault** и может быть предпросмотрен
через `--dry-run`.

```bash
# сначала предпросмотр (рекомендуется, ничего не изменяет)
./install.sh --obsidian-vault /путь/к/любому/vault --dry-run

# реальная установка в профиль "web" + настройка Obsidian
./install.sh --obsidian-vault /путь/к/любому/vault

# установка в другой профиль DSH
./install.sh --profile headless --obsidian-vault /путь/к/любому/vault

# только DSH (пропустить Obsidian)
./install.sh --no-obsidian
```

Запустите `./install.sh --help` для полного списка опций. Основные:

| Опция | Значение |
|-------|----------|
| `--profile <name>` | Профиль DSH для установки (по умолчанию `web`) |
| `--dsh-home <dir>` | Корень данных DSH (по умолчанию `$DSH_HOME` или `~/.dsh`) |
| `--obsidian-vault <dir>` | Любой Obsidian vault для настройки (поддерживает произвольный путь) |
| `--package <src>` | Источник плагина: `<tgz>` / `<npm name>` / `link:<dir>` |
| `--node-bin <path>` | Бинарник node для custom agent |
| `--profile-env` | Вывести рекомендуемые переменные окружения адаптера |
| `--no-obsidian` | Пропустить шаг настройки Obsidian |
| `--dry-run` | Только предпросмотр, ничего не изменяет |
| `--uninstall` | Восстановить резервные копии, удалить DSH-плагин (`dsh plugin remove`) и конфигурацию Obsidian, добавленные этим скриптом |

## Автономное использование

После установки пакета (или прямо из клонированного репозитория):

```bash
node dsh-acp.mjs            # обслуживать ACP v1 на stdin/stdout
node scripts/test-client.js "reply with just the word HELLO"
```

### Конфигурация (Obsidian Agent Client)

Настроить custom agent можно двумя способами: **в один клик** (запустите
`install.sh --obsidian-vault <vault>`, см. выше) или **вручную**, как описано ниже.

**Ручные шаги в Obsidian:**

1. Установите плагин **Agent Client** (Настройки → Сторонние плагины → Обзор →
   поиск "Agent Client") и включите его.
2. Откройте настройки плагина → **Custom Agents** → **Add**.
3. Заполните:
   - **ID**: `dsh-acp`
   - **Display name**: `DeepSeek Harness (ACP)`
   - **Command**: абсолютный путь к `dsh-acp.mjs` из этого пакета
   - **Args**: *пусто*
   - **Env** (необязательно): например,
     `DSH_ACP_LOG_DIR` → `/абсолютный/путь/к/логам`
4. Установите **nodePath** плагина на реальный бинарник `node` (>= 22.13),
   чтобы корректно обрабатывался shebang.
5. Перезагрузите Obsidian (Cmd-R) и выберите *DeepSeek Harness (ACP)*
   в выборе агента.

Если конфигурируете непосредственным редактированием `data.json`:

```json
{
  "id": "dsh-acp",
  "displayName": "DeepSeek Harness (ACP)",
  "command": "/absolute/path/to/dsh-acp/dsh-acp.mjs",
  "args": [],
  "env": [{ "name": "DSH_ACP_LOG_DIR", "value": "/absolute/path/to/dsh-acp/logs" }]
}
```

## Использование cordis-плагина

Установите в профиль DSH через официальный механизм плагинов (благодаря манифесту
`dsh.bundle` в `package.json` плагин можно установить через `dsh plugin add`):

```bash
# из npm registry (после публикации)
dsh plugin --profile web add obsidian-dsh-acp

# из локального артефакта публикации (tarball)
dsh plugin --profile web add ./obsidian-dsh-acp-0.1.0.tgz

# из локального клона (симлинк, режим разработки)
dsh plugin --profile web add -w link:/path/to/dsh-acp
```

Проверьте, что плагин зарегистрирован в конфигурационном дереве профиля:

```bash
dsh --profile web --dump-config | grep -A1 "dsh-acp"
# -> # == obsidian-dsh-acp
#    - id: dsh-acp
#      name: obsidian-dsh-acp
```

Плагин считывает `cordis.patch.yml`, вставляет запись `dsh-acp` в дерево плагинов
профиля, после чего предоставляет сервис `dsh.acp`:

- `ctx.get("dsh.acp")` — экземпляр `DshAcpService`.
- `service.start()` / `service.stop()` — запуск / завершение дочернего процесса
  адаптера.
- `service.process` — активный `ChildProcess` (null, когда не запущен).

### Переменные окружения адаптера

Запущенный процесс `dsh --profile <name>` читает эти переменные окружения. Задайте
их для адаптера (через `env` custom-agent в Obsidian или для профиля/управляемого
процесса) по мере необходимости:

| Переменная | Значение | По умолчанию |
|------------|----------|--------------|
| `DSH_BIN` | исполняемый файл `dsh` | `dsh` из PATH |
| `DSH_PROFILE` | запускаемый профиль | `headless` |
| `DSH_ARGS` | дополнительные аргументы перед промптом (через пробел) | *отсутствуют* |
| `DSH_ACP_LOG_DIR` | каталог для журнала выполнения | *выключено* |
| `DSH_ACP_LOG_MAX_BYTES` | предел размера (байт) до ротации журнала | `5242880` (5 МБ) |
| `DSH_ACP_LOG_KEEP` | число сохраняемых ротированных файлов `.1`/`.2`… | `2` |
| `DSH_ACP_STORE_DIR` | каталог постоянного JSON-индекса сессий | `~/.dsh-acp` |
| `DSH_ACP_PERSIST_DEBOUNCE_MS` | окно дебаунса (мс) для слияния записи индекса | `100` |
| `DSH_ACP_ARCHIVE_IN_MAIN` | помещать архивы ходов в `sessions/` вместо `dsh-acp-archives/` | `0` |

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
