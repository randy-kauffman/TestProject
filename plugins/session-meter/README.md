# session-meter

Un mod de Claude Code: una barra de progreso arriba del prompt y un panel con el costo, los tokens, el contexto y el tiempo de toda la sesión. Funciona solo, sin ninguna skill: la barra sigue la lista de tareas que Claude ya usa.

Inspirado en [savvy-progress](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress) (MIT), reescrito para no depender de savvy-flow.

## Qué muestra

- **Barra de progreso**: la tarea en curso, tareas hechas de las planificadas, porcentaje y costo de la sesión, con el cangrejo caminando mientras Claude trabaja. Se alimenta sola de `TodoWrite` o de `TaskCreate`/`TaskUpdate`/`TaskList`. El botón `×N` (o `≡`) abre el panel y `✕` la oculta hasta la próxima tanda de tareas.
- **Panel de sesión** (`/session-meter` lo abre y lo cierra; `/session-meter texto` lo muestra como texto en la conversación, y `/session-meter debug` dice en qué superficie se dibujó): costo total, tokens, tiempo y contexto usado; la lista de tareas; la sesión principal y cada subagente (en curso y terminados) con modelo, esfuerzo, contexto, tokens, costo estimado y tiempo; y lo que el motor corre por su cuenta (compactación, forks).

## Herramientas que agrega

Ninguna hace falta: la barra ya sigue la lista de tareas.

- `mcp__session-meter__progress`: opcional, para ponerle título al trabajo o informar progreso sin lista de tareas.
- `mcp__session-meter__step`: un subagente informa sus propios pasos (`done`, `total`, `note`). Si no lo hace, su barra muestra el contexto en gris.

## Cómo se calcula el costo

- **El total** es la cifra del propio motor, la misma que `/cost`. No es una estimación.
- **Cada fila** (sesión principal, subagentes) es una estimación: tokens × la tabla de precios. Un modelo sin precio no se adivina: la fila dice "sin precio".

## Opciones

En `/config`, o a mano en `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "session-meter": { "options": { "language": "es", "band": "auto", "prices": "" } } } }
```

- `language`: `auto` (predeterminado), `es`, `en` o `ru`. `auto` sigue el ajuste `language` de Claude Code y después el locale del sistema.
- `band`: `auto` muestra la barra cuando hay lista de tareas o subagentes; `always` además muestra una línea con el costo cuando no hay nada; `off` nunca la muestra.
- `prices`: precios propios en USD por millón de tokens, que se miran antes de la tabla incluida: `fragmento-del-modelo=entrada/salida/lectura-cache/escritura-cache; ...`. Ejemplo: `opus-5-5=4/20/0.2/5; sonnet=2/10/0.2/2.5`.

## Dónde se ve

La barra y el panel los dibuja la interfaz de Claude Code: la terminal o la app de escritorio en una sesión local. Una sesión en la nube vista desde una app que no dibuja mods no muestra ninguno de los dos; ahí `/session-meter` avisa y muestra el resumen en texto, igual que `/session-meter texto`.

## Instalación

En una sesión de Claude Code en la terminal:

```
/plugin install session-meter --marketplace randy-kauffman/TestProject
```

Responder `y` para agregar el marketplace y elegir el alcance (usuario). Para probarlo desde una copia local: `claude --plugin-dir plugins/session-meter`.

## Desarrollo

```bash
claude plugin validate plugins/session-meter
claude plugin test plugins/session-meter
```
