/*
	This file is part of FreeJ2ME.

	FreeJ2ME is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.

	FreeJ2ME is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
	GNU General Public License for more details.

	You should have received a copy of the GNU General Public License
	along with FreeJ2ME.  If not, see http://www.gnu.org/licenses/
*/
package javax.microedition.io;

import java.io.InputStream;
import java.io.OutputStream;

import javax.wireless.messaging.impl.MessageConnectionImpl;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.Socket;
import java.net.URL;
import java.net.URLEncoder;
import java.util.LinkedHashMap;
import java.util.Map;

import org.recompile.mobile.Mobile;
import pl.zb3.freej2me.bridge.shell.Shell;

public class Connector
{

	public static final int READ = 1;
	public static final int READ_WRITE = 3;
	public static final int WRITE = 2;

	
	public static InputStream openInputStream(String name)
	{
		if (name == null) {
			return new fakeIS();
		}
		if (name.startsWith("resource:")) {
			return Mobile.getPlatform().loader.getMIDletResourceAsSiemensStream(name.substring(9).replaceAll("\\\\", "/"));
		}
		try {
			Connection c = open(name);
			if (c instanceof InputConnection) {
				return ((InputConnection) c).openInputStream();
			}
		} catch (Throwable ignored) {
		}
		System.out.println("Faked InputStream for " + name);
		return new fakeIS();
	}


	public static DataInputStream openDataInputStream(String name)
	{
		try {
			Connection c = open(name);
			if (c instanceof InputConnection) {
				return ((InputConnection) c).openDataInputStream();
			}
		} catch (Throwable ignored) {
		}
		System.out.println("Faked DataInputStream: " + name);
		return new DataInputStream(new fakeIS());
	}

	private static class DummyOutputStream extends OutputStream
	{
		public void write(int a) {}
	}

	public static Connection open(String name) throws IOException { 
		if (name == null) {
			throw new ConnectionNotFoundException();
		}
		String normalized = stripParams(name);
		if (normalized.startsWith("sms://")) {
			return new MessageConnectionImpl(normalized);
		}
		if (normalized.startsWith("socket://")) {
			return new SocketConnectionImpl(normalized);
		}
		if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
			return new HttpConnectionImpl(normalized);
		}
		throw new ConnectionNotFoundException();
	}

	public static Connection open(String name, int mode) throws IOException { return open(name); }

	public static Connection open(String name, int mode, boolean timeouts) throws IOException { return open(name); }

	public static DataOutputStream openDataOutputStream(String name) {
		try {
			Connection c = open(name);
			if (c instanceof OutputConnection) {
				return ((OutputConnection) c).openDataOutputStream();
			}
		} catch (Throwable ignored) {
		}
		return new DataOutputStream(new DummyOutputStream());
	}

	public static OutputStream openOutputStream(String name) {
		try {
			Connection c = open(name);
			if (c instanceof OutputConnection) {
				return ((OutputConnection) c).openOutputStream();
			}
		} catch (Throwable ignored) {
		}
		return new DummyOutputStream();
	}

	private static String stripParams(String name) {
		int idx = name.indexOf(';');
		if (idx >= 0) {
			return name.substring(0, idx);
		}
		return name;
	}

	private static final class SocketConnectionImpl implements SocketConnection {
		private final String address;
		private final int port;
		private final boolean debug;
		private final Socket socket;
		private final Object wsHandle;
		private InputStream in;
		private OutputStream out;

		SocketConnectionImpl(String socketUrl) throws IOException {
			String hostPort = socketUrl.substring("socket://".length());
			int slashIdx = hostPort.indexOf('/');
			if (slashIdx >= 0) {
				hostPort = hostPort.substring(0, slashIdx);
			}
			int colonIdx = hostPort.lastIndexOf(':');
			if (colonIdx <= 0 || colonIdx >= hostPort.length() - 1) {
				throw new IOException("Invalid socket URL: " + socketUrl);
			}
			this.address = hostPort.substring(0, colonIdx);
			this.port = Integer.parseInt(hostPort.substring(colonIdx + 1));
			this.debug = "true".equalsIgnoreCase(System.getProperty("freej2me.netDebug"));

			String wsProxy = System.getProperty("freej2me.socketProxy");
			if (wsProxy != null && wsProxy.length() > 0) {
				String proxyUrl = wsProxy;
				if (!proxyUrl.contains("?")) {
					if (!proxyUrl.endsWith("/")) {
						proxyUrl += "/";
					}
					proxyUrl += "?";
				} else if (!proxyUrl.endsWith("&") && !proxyUrl.endsWith("?")) {
					proxyUrl += "&";
				}
				proxyUrl += "host=" + URLEncoder.encode(this.address, "UTF-8") + "&port=" + this.port;
				this.wsHandle = Shell.netSocketOpen(proxyUrl);
				this.socket = null;
				if (debug) {
					System.out.println("Socket proxy open " + proxyUrl);
				}
				return;
			}

			this.wsHandle = null;
			this.socket = new Socket(this.address, this.port);
			try {
				socket.setTcpNoDelay(true);
				socket.setKeepAlive(true);
			} catch (Throwable ignored) {
			}
			if (debug) {
				System.out.println("Socket open " + address + ":" + port);
			}
		}

		@Override
		public DataInputStream openDataInputStream() {
			return new DataInputStream(openInputStream());
		}

		@Override
		public InputStream openInputStream() {
			if (in != null) {
				return in;
			}
			if (wsHandle != null) {
				in = new WsInputStream(wsHandle);
				return in;
			}
			try {
				in = new BufferedInputStream(new NonZeroInputStream(socket.getInputStream()), 8192);
				return in;
			} catch (IOException e) {
				throw new RuntimeException(e);
			}
		}

		@Override
		public DataOutputStream openDataOutputStream() {
			return new DataOutputStream(openOutputStream());
		}

		@Override
		public OutputStream openOutputStream() {
			if (out != null) {
				return out;
			}
			if (wsHandle != null) {
				out = new WsOutputStream(wsHandle);
				return out;
			}
			try {
				out = new BufferedOutputStream(socket.getOutputStream(), 8192);
				return out;
			} catch (IOException e) {
				throw new RuntimeException(e);
			}
		}

		@Override
		public void close() {
			if (wsHandle != null) {
				try {
					Shell.netSocketClose(wsHandle);
				} catch (Throwable ignored) {
				}
			} else if (socket != null) {
				try {
					if (out != null) {
						try {
							out.flush();
						} catch (IOException ignored) {
						}
					}
					if (in != null) {
						try {
							in.close();
						} catch (IOException ignored) {
						}
					}
					if (out != null) {
						try {
							out.close();
						} catch (IOException ignored) {
						}
					}
					socket.close();
				} catch (IOException ignored) {
				}
			}
			if (debug) {
				System.out.println("Socket closed " + address + ":" + port);
			}
		}

		@Override
		public String getAddress() {
			return address;
		}

		@Override
		public String getLocalAddress() {
			if (socket == null) {
				return null;
			}
			return socket.getLocalAddress() != null ? socket.getLocalAddress().getHostAddress() : null;
		}

		@Override
		public int getLocalPort() {
			if (socket == null) {
				return 0;
			}
			return socket.getLocalPort();
		}

		@Override
		public int getPort() {
			return port;
		}

		@Override
		public int getSocketOption(byte option) {
			if (socket == null) {
				return 0;
			}
			try {
				switch (option) {
					case DELAY:
						return socket.getTcpNoDelay() ? 1 : 0;
					case KEEPALIVE:
						return socket.getKeepAlive() ? 1 : 0;
					case LINGER:
						return socket.getSoLinger();
					case RCVBUF:
						return socket.getReceiveBufferSize();
					case SNDBUF:
						return socket.getSendBufferSize();
					default:
						throw new IllegalArgumentException("Unknown option: " + option);
				}
			} catch (IOException e) {
				throw new RuntimeException(e);
			}
		}

		@Override
		public void setSocketOption(byte option, int value) {
			if (socket == null) {
				return;
			}
			try {
				switch (option) {
					case DELAY:
						socket.setTcpNoDelay(value != 0);
						return;
					case KEEPALIVE:
						socket.setKeepAlive(value != 0);
						return;
					case LINGER:
						if (value < 0) {
							socket.setSoLinger(false, 0);
						} else {
							socket.setSoLinger(true, value);
						}
						return;
					case RCVBUF:
						socket.setReceiveBufferSize(value);
						return;
					case SNDBUF:
						socket.setSendBufferSize(value);
						return;
					default:
						throw new IllegalArgumentException("Unknown option: " + option);
				}
			} catch (IOException e) {
				throw new RuntimeException(e);
			}
		}
	}

	private static final class NonZeroInputStream extends FilterInputStream {
		NonZeroInputStream(InputStream in) {
			super(in);
		}

		@Override
		public int read(byte[] b, int off, int len) throws IOException {
			int r;
			while ((r = super.read(b, off, len)) == 0) {
				try {
					Thread.sleep(1L);
				} catch (InterruptedException e) {
					Thread.currentThread().interrupt();
					break;
				}
			}
			return r;
		}
	}

	private static final class WsInputStream extends InputStream {
		private final Object handle;
		private final byte[] one = new byte[1];

		WsInputStream(Object handle) {
			this.handle = handle;
		}

		@Override
		public int read() throws IOException {
			int r = read(one, 0, 1);
			if (r <= 0) {
				return -1;
			}
			return one[0] & 0xFF;
		}

		@Override
		public int read(byte[] b, int off, int len) throws IOException {
			int r;
int eofCount = 0;
while (true) {
r = Shell.netSocketRead(handle, b, off, len);
if (r > 0) {
return r;
}
if (r < 0) {
eofCount++;
if (eofCount >= 3) {
return -1;
}
}
try {
Thread.sleep(r < 0 ? 20L : 1L);
} catch (InterruptedException e) {
Thread.currentThread().interrupt();
return -1;
}
}
		}
	}

	private static final class WsOutputStream extends OutputStream {
		private final Object handle;
		private byte[] buf = new byte[2048];
		private int size = 0;

		WsOutputStream(Object handle) {
			this.handle = handle;
		}

		@Override
		public void write(int b) throws IOException {
			ensureCapacity(1);
			buf[size++] = (byte) b;
		}

		@Override
		public void write(byte[] b, int off, int len) throws IOException {
			if (b == null) {
				throw new NullPointerException();
			}
			if (off < 0 || len < 0 || off + len > b.length) {
				throw new IndexOutOfBoundsException();
			}
			if (len == 0) {
				return;
			}
			ensureCapacity(len);
			System.arraycopy(b, off, buf, size, len);
			size += len;
			if (size >= 2048) {
				flush();
			}
		}

		@Override
		public void flush() throws IOException {
			if (size <= 0) {
				return;
			}
			Shell.netSocketWrite(handle, buf, 0, size);
			size = 0;
		}

		@Override
		public void close() throws IOException {
			flush();
		}

		private void ensureCapacity(int add) {
			int req = size + add;
			if (req <= buf.length) {
				return;
			}
			int n = buf.length;
			while (n < req) {
				n *= 2;
			}
			byte[] nb = new byte[n];
			System.arraycopy(buf, 0, nb, 0, size);
			buf = nb;
		}
	}

	private static final class HttpConnectionImpl implements HttpConnection {
		private final String urlString;
		private final URL url;
		private final Map<String, String> requestProps = new LinkedHashMap<String, String>();
		private String requestMethod = GET;
		private boolean doOutput = false;
		private HttpURLConnection conn;

		HttpConnectionImpl(String urlString) throws IOException {
			this.urlString = urlString;
			this.url = new URL(urlString);
		}

		private void ensureConnected() throws IOException {
			if (conn != null) {
				return;
			}
			conn = (HttpURLConnection) url.openConnection();
			conn.setInstanceFollowRedirects(true);
			conn.setRequestMethod(requestMethod);
			conn.setDoInput(true);
			conn.setDoOutput(doOutput);
			for (Map.Entry<String, String> e : requestProps.entrySet()) {
				conn.setRequestProperty(e.getKey(), e.getValue());
			}
		}

		@Override
		public DataInputStream openDataInputStream() {
			return new DataInputStream(openInputStream());
		}

		@Override
		public InputStream openInputStream() {
			try {
				ensureConnected();
				InputStream err = conn.getErrorStream();
				if (err != null && conn.getResponseCode() >= 400) {
					return err;
				}
				return conn.getInputStream();
			} catch (IOException e) {
				throw new RuntimeException(e);
			}
		}

		@Override
		public DataOutputStream openDataOutputStream() {
			return new DataOutputStream(openOutputStream());
		}

		@Override
		public OutputStream openOutputStream() {
			try {
				doOutput = true;
				ensureConnected();
				return conn.getOutputStream();
			} catch (IOException e) {
				throw new RuntimeException(e);
			}
		}

		@Override
		public void close() {
			if (conn != null) {
				conn.disconnect();
				conn = null;
			}
		}

		@Override
		public String getEncoding() {
			try {
				ensureConnected();
				return conn.getContentEncoding();
			} catch (IOException e) {
				return null;
			}
		}

		@Override
		public long getLength() {
			try {
				ensureConnected();
				long v = conn.getContentLengthLong();
				if (v >= 0) {
					return v;
				}
				return conn.getContentLength();
			} catch (Throwable e) {
				try {
					return conn != null ? conn.getContentLength() : -1;
				} catch (Throwable ignored) {
					return -1;
				}
			}
		}

		@Override
		public String getType() {
			try {
				ensureConnected();
				return conn.getContentType();
			} catch (IOException e) {
				return null;
			}
		}

		@Override
		public long getDate() {
			try {
				ensureConnected();
				return conn.getDate();
			} catch (IOException e) {
				return 0;
			}
		}

		@Override
		public long getExpiration() {
			try {
				ensureConnected();
				return conn.getExpiration();
			} catch (IOException e) {
				return 0;
			}
		}

		@Override
		public String getFile() {
			return url.getFile();
		}

		@Override
		public String getHeaderField(int n) {
			try {
				ensureConnected();
				return conn.getHeaderField(n);
			} catch (IOException e) {
				return null;
			}
		}

		@Override
		public String getHeaderField(String name) {
			try {
				ensureConnected();
				return conn.getHeaderField(name);
			} catch (IOException e) {
				return null;
			}
		}

		@Override
		public long getHeaderFieldDate(String name, long def) {
			try {
				ensureConnected();
				return conn.getHeaderFieldDate(name, def);
			} catch (IOException e) {
				return def;
			}
		}

		@Override
		public int getHeaderFieldInt(String name, int def) {
			try {
				ensureConnected();
				return conn.getHeaderFieldInt(name, def);
			} catch (IOException e) {
				return def;
			}
		}

		@Override
		public String getHeaderFieldKey(int n) {
			try {
				ensureConnected();
				return conn.getHeaderFieldKey(n);
			} catch (IOException e) {
				return null;
			}
		}

		@Override
		public String getHost() {
			return url.getHost();
		}

		@Override
		public long getLastModified() {
			try {
				ensureConnected();
				return conn.getLastModified();
			} catch (IOException e) {
				return 0;
			}
		}

		@Override
		public int getPort() {
			int p = url.getPort();
			if (p != -1) {
				return p;
			}
			return url.getDefaultPort();
		}

		@Override
		public String getProtocol() {
			return url.getProtocol();
		}

		@Override
		public String getQuery() {
			return url.getQuery();
		}

		@Override
		public String getRef() {
			return url.getRef();
		}

		@Override
		public String getRequestMethod() {
			return requestMethod;
		}

		@Override
		public String getRequestProperty(String key) {
			return requestProps.get(key);
		}

		@Override
		public int getResponseCode() {
			try {
				ensureConnected();
				return conn.getResponseCode();
			} catch (IOException e) {
				return -1;
			}
		}

		@Override
		public String getResponseMessage() {
			try {
				ensureConnected();
				return conn.getResponseMessage();
			} catch (IOException e) {
				return null;
			}
		}

		@Override
		public String getURL() {
			return urlString;
		}

		@Override
		public void setRequestMethod(String method) {
			if (method == null) {
				throw new IllegalArgumentException();
			}
			this.requestMethod = method;
			if (conn != null) {
				try {
					conn.setRequestMethod(method);
				} catch (IOException ignored) {
				}
			}
		}

		@Override
		public void setRequestProperty(String key, String value) {
			if (key == null) {
				throw new IllegalArgumentException();
			}
			if (value == null) {
				requestProps.remove(key);
			} else {
				requestProps.put(key, value);
			}
			if (conn != null) {
				conn.setRequestProperty(key, value);
			}
		}
	}

	// fake inputstream 
	private static class fakeIS extends InputStream
	{
		public int avaliable() { return 0; }

		public void close() { }

		public void mark() { }

		public boolean markSupported() { return false; }

		public int read() { return 0; }

		public int read(byte[] b) { return 0; }
		
		public int read(byte[] b, int off, int len) { return 0; }

		public void reset() { }

		public long skip(long n) { return (long)0; }
	}

}
