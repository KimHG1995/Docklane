FROM busybox:1.36

ARG VERSION=unknown

RUN mkdir -p /www && printf '%s\n' "$VERSION" > /www/index.html

EXPOSE 8080

CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
