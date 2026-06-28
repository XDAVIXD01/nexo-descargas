# NexoDescargas

Gestor de descargas de escritorio para Windows, pensado para enlaces públicos de:

- Marketcat Drive
- RapidShare.co
- LolaUp
- Solred

Incluye cola persistente y reordenable, descargas simultáneas, pausa y reanudación mediante HTTP Range, reintentos automáticos, medición suavizada de velocidad, tiempos estimados, límite de velocidad, búsqueda, detección de duplicados y un instalador NSIS.

Al cerrar la ventana, NexoDescargas permanece en la bandeja del sistema para que las transferencias continúen. La opción **Salir completamente** está disponible en el menú del icono de la bandeja.

La cola, las preferencias y el progreso se guardan en disco. Tras un cierre inesperado o apagón, la aplicación verifica el tamaño real de los archivos parciales y reanuda las descargas pendientes.

Cuando un servidor admite HTTP Range, la reanudación continúa directamente desde el byte guardado. Si un servidor ignora Range (como ocurre actualmente con Marketcat), NexoDescargas conserva el archivo parcial, vuelve a leer por red el tramo previo sin escribirlo de nuevo y continúa anexando desde el punto correcto. La interfaz muestra **Recuperando punto de reanudación…** durante ese proceso.

En Windows, las preferencias se almacenan en `%APPDATA%\nexo-descargas\config.json`, con una copia de seguridad `config.json.bak`. El estado de la cola se conserva por separado en `state.json`.

## Desarrollo

Requiere Node.js 20 o superior.

```powershell
npm install
npm run dev
```

## Compilar e instalar

```powershell
npm test
npm run dist
```

El instalador se genera en `release/`.

## Alcance

NexoDescargas trabaja con enlaces que el usuario ya puede descargar públicamente. No evade CAPTCHA, contraseñas, pagos ni límites impuestos por los sitios. Los adaptadores pueden necesitar ajustes si un proveedor cambia su página o API.

## Licencia

MIT
